"""Local GeoSandbox services. GIS computation continues to use GeoLibre's routers."""
from __future__ import annotations

import json
import os
import tempfile
import re
import uuid
import hashlib
import threading
from datetime import datetime, timezone
from urllib.parse import quote
from pathlib import Path

import httpx
import keyring
from fastapi import APIRouter, HTTPException, Request, File, Form, Query, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse
from pydantic import BaseModel, Field
from .sandbox_storage import ArchiveChange, atomic_write, check_origin, data_root, local_entry
from .sandbox_recovery import router as recovery_router
from .sandbox_native_jobs import router as native_jobs_router
from .sandbox_maintenance import router as maintenance_router

router = APIRouter()
router.include_router(recovery_router)
router.include_router(native_jobs_router)
router.include_router(maintenance_router)
MAX_CHAT_BYTES = 2 * 1024 * 1024
EXPORT_ID = re.compile(r"[a-f0-9]{32}_[^/\\\x00-\x1f]{1,120}")
EXPORT_REQUEST_ID = re.compile(r"[a-f0-9]{32}")
_EXPORT_LOCK = threading.RLock()


def _export_receipt(request_id: str):
    folder = data_root() / "exports"
    if not folder.is_dir():
        return None
    for entry in folder.iterdir():
        if entry.name.startswith(request_id + "_") and EXPORT_ID.fullmatch(entry.name):
            if entry.is_symlink() or not entry.is_file() or entry.resolve().parent != folder.resolve():
                continue
            digest, total = hashlib.sha256(), 0
            with entry.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
                    total += len(chunk)
            return {"requestId": request_id, "path": str(entry), "bytes": total, "sha256": digest.hexdigest(),
                    "downloadUrl": f"/sandbox-api/exports/{quote(entry.name, safe='')}"}
    return None


@router.get("/sandbox/export-receipts/{request_id}")
def export_receipt(request_id: str, request: Request):
    check_origin(request)
    if not EXPORT_REQUEST_ID.fullmatch(request_id):
        raise HTTPException(422, "保存回执编号无效")
    with _EXPORT_LOCK:
        result = _export_receipt(request_id)
    if result is None:
        raise HTTPException(404, "尚无已提交成果；仍在写入的文件不会显示")
    return result


@router.post("/sandbox/exports")
def save_export(request: Request, file: UploadFile = File(...)):
    """Save generated deliverables beside the D-drive project, avoiding browser C-drive caches."""
    check_origin(request)
    request_id = request.headers.get("x-geosandbox-export-id") or uuid.uuid4().hex
    if not EXPORT_REQUEST_ID.fullmatch(request_id):
        raise HTTPException(422, "保存回执编号无效")
    filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", file.filename or "export.bin").strip(". ") or "export.bin"
    if len(filename) > 120:
        suffix = Path(filename).suffix
        suffix = suffix if len(suffix) <= 20 else ""
        filename = filename[:120 - len(suffix)].rstrip(". ") + suffix
    folder = data_root() / "exports"
    folder.mkdir(exist_ok=True)
    export_id = request_id + "_" + filename
    path = folder / export_id
    total, digest = 0, hashlib.sha256()
    def write(output):
        nonlocal total
        while chunk := file.file.read(1024 * 1024):
            total += len(chunk)
            if total > 256 * 1024 * 1024:
                raise HTTPException(413, "成果超过 256 MiB，请分组导出")
            output.write(chunk)
            digest.update(chunk)
    try:
        with _EXPORT_LOCK:
            existing = _export_receipt(request_id)
            if existing is not None:
                replay = hashlib.sha256()
                while chunk := file.file.read(1024 * 1024):
                    total += len(chunk)
                    if total > 256 * 1024 * 1024:
                        raise HTTPException(413, "成果超过 256 MiB，请分组导出")
                    replay.update(chunk)
                if existing["path"] != str(path) or existing["bytes"] != total or existing["sha256"] != replay.hexdigest():
                    raise HTTPException(409, "该保存编号已有不同成果，原文件未改变")
                return existing
            atomic_write(path, write)
    except OSError:
        raise HTTPException(507, "成果未保存：磁盘不可写或空间不足，原有成果未改变") from None
    return {"requestId": request_id, "path": str(path), "bytes": total, "sha256": digest.hexdigest(), "downloadUrl": f"/sandbox-api/exports/{quote(export_id, safe='')}"}


@router.get("/sandbox/exports/{export_id}")
def download_export(export_id: str):
    if not EXPORT_ID.fullmatch(export_id):
        raise HTTPException(404, "成果不存在")
    folder = data_root() / "exports"
    path = folder / export_id
    if path.resolve().parent != folder.resolve() or not path.is_file():
        raise HTTPException(404, "成果不存在")
    return FileResponse(path, filename=export_id[33:], media_type="application/octet-stream")


@router.get("/sandbox/projects")
def recent_projects(request: Request):
    check_origin(request)
    projects, names = [], set()
    with _EXPORT_LOCK:
        entries = _export_entries(False, project_only=True)
    for entry in entries:
        name = entry["name"][:-len(".geosandbox")]
        if name in names:
            continue
        names.add(name)
        projects.append({**entry, "name": name})
        if len(projects) == 20:
            break
    return {"projects": projects, "directory": str(data_root() / "exports")}


def _archive_markers():
    folder = data_root() / "export-archive"
    return local_entry(folder, directory=True)


def _archive_key(export_id: str):
    return hashlib.sha256(export_id.encode("utf-8")).hexdigest()


def _export_entries(archived: bool, *, project_only: bool = False):
    folder = local_entry(data_root() / "exports", directory=True)
    markers = _archive_markers()
    archived_keys = {marker.name for marker in markers.iterdir() if local_entry(marker)} if markers else set()
    entries = []
    if folder:
        for path in folder.iterdir():
            export_id = path.name
            if not EXPORT_ID.fullmatch(export_id) or (project_only and not export_id.lower().endswith(".geosandbox")):
                continue
            if (_archive_key(export_id) in archived_keys) != archived or not local_entry(path):
                continue
            try:
                info = path.stat()
            except FileNotFoundError:
                continue
            entries.append((info.st_mtime, export_id, info.st_size))
    return [{"exportId": export_id, "name": export_id[33:], "bytes": size,
             "modifiedAt": datetime.fromtimestamp(modified, timezone.utc).isoformat(),
             "downloadUrl": f"/sandbox-api/exports/{quote(export_id, safe='')}"}
            for modified, export_id, size in sorted(entries, reverse=True)]


@router.get("/sandbox/export-library")
def list_exports(request: Request, archived: bool = False, offset: int = Query(0, ge=0)):
    check_origin(request)
    with _EXPORT_LOCK:
        entries = _export_entries(archived)
    return {"items": entries[offset:offset + 20], "total": len(entries)}


@router.patch("/sandbox/export-library/{export_id}")
def archive_export(export_id: str, request: Request, change: ArchiveChange):
    check_origin(request)
    with _EXPORT_LOCK:
        folder = local_entry(data_root() / "exports", directory=True)
        if not EXPORT_ID.fullmatch(export_id) or not folder or not local_entry(folder / export_id):
            raise HTTPException(404, "成果不存在")
        canonical_id = (folder / export_id).resolve().name
        if not EXPORT_ID.fullmatch(canonical_id):
            raise HTTPException(404, "成果不存在")
        try:
            (data_root() / "export-archive").mkdir(exist_ok=True)
            markers = _archive_markers()
            if not markers:
                raise OSError("Invalid marker directory")
            marker = markers / _archive_key(canonical_id)
            if (marker.exists() or marker.is_symlink()) and not local_entry(marker):
                raise OSError("Invalid archive marker")
            if change.archived and not marker.exists():
                atomic_write(marker, lambda output: output.write(b"archived\n"))
            elif not change.archived:
                marker.unlink(missing_ok=True)
        except OSError:
            raise HTTPException(507, "归档标记未更新，请检查磁盘后刷新列表") from None
    return {"archived": change.archived}


@router.post("/sandbox/vector-upload")
def import_vector(request: Request, file: UploadFile = File(...), source_crs: str = Form(""), force_crs: bool = Form(False)):
    """Native fallback for common vectors, using GDAL/PROJ through Pyogrio/GeoPandas."""
    check_origin(request)

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".gpkg", ".zip", ".geojson", ".json"}:
        raise HTTPException(422, "支持 GPKG、ZIP Shapefile 和 GeoJSON")
    asset_id = uuid.uuid4().hex + suffix
    asset_dir = data_root() / "assets"
    asset_dir.mkdir(exist_ok=True)
    path = asset_dir / asset_id
    total = 0
    with path.open("wb") as output:
        while chunk := file.file.read(1024 * 1024):
            total += len(chunk)
            if total > 128 * 1024 * 1024:
                output.close()
                path.unlink(missing_ok=True)
                raise HTTPException(413, "单个矢量文件暂限制为 128 MiB")
            output.write(chunk)
    try:
        from .sandbox_native_worker import convert_vector
        result = convert_vector(path, file.filename or "data", source_crs, force_crs)
        return {"assetUrl": f"/sandbox-api/assets/{asset_id}", "filename": file.filename, "layers": result}
    except Exception as error:
        raise HTTPException(422, str(error)[:600]) from None


@router.get("/sandbox/assets/{asset_id}")
def asset_file(asset_id: str):
    if not re.fullmatch(r"[a-f0-9]{32}\.(?:gpkg|zip|geojson|json|tif|tiff|png)", asset_id):
        raise HTTPException(404, "资源不存在")
    path = data_root() / "assets" / asset_id
    if not path.is_file():
        raise HTTPException(404, "资源不存在")
    return FileResponse(path, media_type="image/png" if path.suffix == ".png" else "application/octet-stream")


@router.post("/sandbox/raster-upload")
def import_raster(request: Request, file: UploadFile = File(...), source_crs: str = Form(""), force_crs: bool = Form(False)):
    """GDAL-backed bounded display preview; preserve the original numeric raster separately."""
    check_origin(request)

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".tif", ".tiff"}:
        raise HTTPException(422, "此入口支持 GeoTIFF / TIF")
    folder = data_root() / "assets"
    folder.mkdir(exist_ok=True)
    asset_id = uuid.uuid4().hex + suffix
    original = folder / asset_id
    total = 0
    with original.open("wb") as output:
        while chunk := file.file.read(1024 * 1024):
            total += len(chunk)
            if total > 128 * 1024 * 1024:
                output.close()
                original.unlink(missing_ok=True)
                raise HTTPException(413, "GeoTIFF 原件暂限制为 128 MiB")
            output.write(chunk)
    try:
        from .sandbox_native_worker import convert_raster
        preview_id = uuid.uuid4().hex + ".png"
        result = convert_raster(original, folder / preview_id, source_crs, force_crs)
        return {"assetUrl": f"/sandbox-api/assets/{asset_id}", "previewUrl": f"/sandbox-api/assets/{preview_id}", **result}
    except Exception as error:
        raise HTTPException(422, str(error)[:600]) from None


def _credential_service() -> str:
    identity = hashlib.sha256(str(data_root().resolve()).encode()).hexdigest()[:16]
    return f"GeoSandbox.DeepSeek.{identity}"


def _write_settings(stored: dict) -> None:
    path = data_root() / "deepseek.local.json"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as output:
        json.dump(stored, output)
        temporary = Path(output.name)
    os.replace(temporary, path)


def _vault_key() -> str:
    try:
        return keyring.get_password(_credential_service(), "api-key") or ""
    except (keyring.errors.KeyringError, RuntimeError):
        raise HTTPException(503, "无法读取系统凭据库，请检查当前用户的凭据服务") from None


def _store_key(key: str) -> None:
    try:
        service = _credential_service()
        if key:
            keyring.set_password(service, "api-key", key)
            if keyring.get_password(service, "api-key") != key:
                raise keyring.errors.PasswordSetError()
        elif keyring.get_password(service, "api-key") is not None:
            keyring.delete_password(service, "api-key")
    except (keyring.errors.KeyringError, RuntimeError):
        raise HTTPException(503, "无法保存到系统凭据库，密钥未写入配置文件") from None


def _settings() -> dict:
    path = data_root() / "deepseek.local.json"
    stored = json.loads(path.read_text("utf-8")) if path.exists() else {}
    # Migrate the first local version only after the OS vault confirms the write.
    if "apiKey" in stored:
        legacy = stored.pop("apiKey") or ""
        _store_key(legacy)
        stored["keyStored"] = bool(legacy)
        _write_settings(stored)
    return stored


def config() -> dict:
    stored = _settings()
    return {
        "apiKey": os.environ.get("DEEPSEEK_API_KEY") or (_vault_key() if stored.get("keyStored") else ""),
        "model": os.environ.get("DEEPSEEK_MODEL") or stored.get("model", "deepseek-flash"),
    }


@router.get("/sandbox/status")
def status():
    settings = config()
    return {"configured": bool(settings["apiKey"]), "model": settings["model"], "provider": "DeepSeek", "storage": str(data_root()), "upstream": "https://api.deepseek.com", "keySource": "environment" if os.environ.get("DEEPSEEK_API_KEY") else ("system-credential-store" if settings["apiKey"] else "none"), "settingsMutable": os.environ.get("GEOSANDBOX_SERVER") != "1"}


class Settings(BaseModel):
    apiKey: str | None = Field(default=None, max_length=512)
    model: str = Field(min_length=1, max_length=128)


@router.post("/sandbox/config")
def save_config(body: Settings, request: Request):
    check_origin(request)
    if os.environ.get("GEOSANDBOX_SERVER") == "1":
        raise HTTPException(403, "服务器模式从环境配置 DeepSeek，凭据由部署者管理")
    if any(c.isspace() for c in body.model):
        raise HTTPException(422, "模型名称不能包含空格")
    stored = _settings()
    stored["model"] = body.model
    if body.apiKey is not None:
        key = body.apiKey.strip()
        if any(c.isspace() for c in key):
            raise HTTPException(422, "密钥不能包含空白字符")
        _store_key(key)
        stored["keyStored"] = bool(key)
    _write_settings(stored)
    return status()


@router.post("/ai/v1/chat/completions")
async def chat(request: Request):
    check_origin(request)
    settings = config()
    if not settings["apiKey"]:
        return JSONResponse({"error": {"message": "尚未配置 DeepSeek API Key，请在空间装配 → 交付 → DeepSeek 中设置。本地编辑不受影响。", "type": "configuration_error"}}, status_code=503)
    payload = bytearray()
    async for chunk in request.stream():
        payload.extend(chunk)
        if len(payload) > MAX_CHAT_BYTES:
            raise HTTPException(413, "AI 请求超过 2 MiB，请缩小上下文")
    try:
        body = json.loads(payload)
    except (ValueError, UnicodeError):
        raise HTTPException(400, "请求不是有效 JSON") from None
    if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
        raise HTTPException(422, "缺少 messages 数组")
    body["model"] = settings["model"]
    # Use the provider's documented non-thinking tool-call path with the existing SDK.
    body["thinking"] = {"type": "disabled"}
    try:
        body["max_tokens"] = min(max(int(body.get("max_tokens") or 4096), 1), 8192)
    except (ValueError, TypeError, OverflowError):
        raise HTTPException(422, "max_tokens 必须是整数") from None
    client = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=20.0))
    try:
        upstream = await client.send(client.build_request("POST", "https://api.deepseek.com/chat/completions", headers={"Authorization": f"Bearer {settings['apiKey']}", "Content-Type": "application/json"}, json=body), stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(502, "无法连接 DeepSeek，请检查网络后重试") from None
    if upstream.status_code != 200:
        code = upstream.status_code
        await upstream.aclose()
        await client.aclose()
        return JSONResponse({"error": {"message": f"DeepSeek 返回 HTTP {code}；请检查密钥、账户余额和模型名称。", "type": "upstream_error"}}, status_code=code)

    async def chunks():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(chunks(), media_type="text/event-stream" if body.get("stream") else "application/json", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
