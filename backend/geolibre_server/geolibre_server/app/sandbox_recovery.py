"""Incremental local recovery: immutable assets/documents, atomic checkpoint records.

The portable manifest is shared with .geosandbox bundles. Incomplete uploads never
appear in the checkpoint list. Recovery does not mark a project explicitly saved.
"""
import hashlib
import json
import re
import tempfile
import threading
import uuid
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from zipfile import ZipFile, ZIP_DEFLATED

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from .sandbox_storage import atomic_write, check_origin, data_root

router = APIRouter()
MAX_EXPANDED = 256 * 1024 * 1024
MAX_DOCUMENT = 64 * 1024 * 1024
MAX_STORAGE = 2 * 1024 * 1024 * 1024
LOCK = threading.RLock()
HASH = r"^[a-f0-9]{64}$"
PROJECT_ID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", re.IGNORECASE | re.ASCII)


def project_identity(value: Any) -> str | None:
    return value.lower() if isinstance(value, str) and PROJECT_ID.fullmatch(value) else None


class Asset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(pattern=r"^assets/[a-f0-9]{64}\.bin$")
    mime: str = Field(pattern=r"^[\w.+-]+/[\w.+-]+$", max_length=100)
    sha256: str = Field(pattern=HASH)
    bytes: int = Field(ge=0, le=MAX_EXPANDED)


class Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    format: Literal["geosandbox"]
    version: Literal[1]
    assets: list[Asset] = Field(max_length=10000)
    externalReferences: list[str] = Field(max_length=10000)


class Checkpoint(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project: dict[str, Any]
    manifest: Manifest


class AssetQuery(BaseModel):
    hashes: list[str] = Field(max_length=10000)


def folder() -> Path:
    result = data_root() / "checkpoints"
    result.mkdir(exist_ok=True)
    return result


def stored_path(kind: str, name: str) -> Path:
    parent = folder() / kind
    parent.mkdir(exist_ok=True)
    path = parent / name
    if not parent.resolve().is_relative_to(folder().resolve()) or path.resolve().parent != parent.resolve() or path.is_symlink():
        raise HTTPException(422, "恢复资源路径无效")
    return path


def encode(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def usage() -> int:
    return sum(p.stat().st_size for kind in ("assets", "documents", "records")
               for p in (folder() / kind).glob("*") if p.is_file() and not p.is_symlink() and not p.name.startswith("."))


def check_budget(incoming: int) -> None:
    if usage() + incoming > MAX_STORAGE:
        raise HTTPException(507, "D 盘恢复区达到 2 GiB 上限，自动恢复点已暂停；旧恢复点仍保留，请另存完整项目包")


def file_digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def records() -> list[dict]:
    result = []
    for path in (folder() / "records").glob("*.json"):
        if path.is_symlink() or not re.fullmatch(r"[a-f0-9]{32}\.json", path.name):
            continue
        try:
            if path.stat().st_size > 4096:
                continue
            record = json.loads(path.read_bytes())
            if record["id"] != path.stem or not re.fullmatch(HASH, record["documentHash"]):
                continue
            if not isinstance(record["name"], str) or not isinstance(record["createdAt"], str):
                continue
            if any(type(record.get(key)) is not int or record[key] < 0 for key in ("layerCount", "assetCount")):
                continue
            record["projectId"] = project_identity(record.get("projectId"))
            record["downloadUrl"] = f"/sandbox-api/checkpoints/{record['id']}/bundle"
            result.append(record)
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return sorted(result, key=lambda r: r["createdAt"], reverse=True)


@router.post("/sandbox/checkpoints/missing-assets")
def missing_assets(request: Request, query: AssetQuery):
    check_origin(request)
    if any(not re.fullmatch(HASH, value) for value in query.hashes):
        raise HTTPException(422, "恢复资源哈希无效")
    with LOCK:
        missing = []
        for digest in set(query.hashes):
            path = stored_path("assets", digest + ".bin")
            if not path.is_file() or file_digest(path) != digest:
                missing.append(digest)
            else:
                # A save that has checked this asset may still be uploading its document.
                # Maintenance retains recently used assets across that request boundary.
                os.utime(path, None)
        return {"missing": sorted(missing)}


@router.post("/sandbox/checkpoints/assets/{digest}")
def upload_asset(request: Request, digest: str, file: UploadFile = File(...)):
    check_origin(request)
    if not re.fullmatch(HASH, digest):
        raise HTTPException(422, "恢复资源哈希无效")
    path = stored_path("assets", digest + ".bin")
    total, checksum = 0, hashlib.sha256()
    def write(output):
        nonlocal total
        while chunk := file.file.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_EXPANDED:
                raise HTTPException(413, "恢复资源超过 256 MiB")
            output.write(chunk)
            checksum.update(chunk)
        if checksum.hexdigest() != digest:
            raise HTTPException(422, "恢复资源上传校验失败")
        check_budget(total)
    try:
        with LOCK:
            if path.is_file() and file_digest(path) == digest:
                os.utime(path, None)
                return {"stored": True, "deduplicated": True}
            atomic_write(path, write)
        return {"stored": True, "deduplicated": False}
    except OSError:
        raise HTTPException(507, "恢复资源未保存：磁盘不可写或空间不足，旧恢复点仍保留") from None


def validate_payload(payload: Checkpoint, *, verify_hashes: bool = True) -> bytes:
    project = payload.project
    if not isinstance(project.get("name"), str) or not isinstance(project.get("version"), str) or not isinstance(project.get("layers"), list):
        raise HTTPException(422, "恢复项目文档无效")
    if len({a.path for a in payload.manifest.assets}) != len(payload.manifest.assets):
        raise HTTPException(422, "恢复清单包含重复资源")
    assets = {"geosandbox-asset:" + a.path for a in payload.manifest.assets}
    def inspect(value):
        if isinstance(value, str):
            if value.startswith("geosandbox-asset:") and value not in assets:
                raise HTTPException(422, "恢复项目引用了清单以外的资源")
            if value.startswith(("data:", "blob:", "/sandbox-api/assets/")):
                raise HTTPException(422, "恢复项目含未收集的本地资源")
        elif isinstance(value, list):
            for item in value:
                inspect(item)
        elif isinstance(value, dict):
            for item in value.values():
                inspect(item)
    inspect(project)
    for asset in payload.manifest.assets:
        if asset.path != f"assets/{asset.sha256}.bin":
            raise HTTPException(422, "恢复资源路径与哈希不一致")
        path = stored_path("assets", asset.sha256 + ".bin")
        if not path.is_file() or path.stat().st_size != asset.bytes or (verify_hashes and file_digest(path) != asset.sha256):
            raise HTTPException(422, "恢复资源缺失或校验失败，请重新创建恢复点")
    try:
        content = encode(payload.model_dump())
    except (ValueError, RecursionError):
        raise HTTPException(422, "恢复文档含无效数值或嵌套过深") from None
    if len(content) > MAX_DOCUMENT or len(content) + sum(a.bytes for a in payload.manifest.assets) > MAX_EXPANDED:
        raise HTTPException(413, "恢复点超过当前容量限制，请拆分项目")
    return content


def commit_checkpoint(payload: Checkpoint):
    try:
        with LOCK:
            content = validate_payload(payload)
            digest = hashlib.sha256(content).hexdigest()
            project_id = project_identity(payload.project.get("id"))
            previous = records()
            latest = next((entry for entry in previous if entry["projectId"] == project_id), None) if project_id else (previous[0] if previous else None)
            if latest and latest["documentHash"] == digest:
                return {**latest, "deduplicated": True}
            document = stored_path("documents", digest + ".json")
            check_budget((0 if document.exists() else len(content)) + 4096)
            if not document.exists() or file_digest(document) != digest:
                atomic_write(document, lambda output: output.write(content))
            record = {"id": uuid.uuid4().hex, "createdAt": datetime.now(timezone.utc).isoformat(),
                      "name": payload.project["name"][:300], "projectId": project_id, "documentHash": digest,
                      "layerCount": len(payload.project["layers"]), "assetCount": len(payload.manifest.assets)}
            record["downloadUrl"] = f"/sandbox-api/checkpoints/{record['id']}/bundle"
            # This small record is the commit point; uncommitted assets/documents stay invisible.
            atomic_write(stored_path("records", record["id"] + ".json"), lambda output: output.write(encode(record)))
            return {**record, "deduplicated": False}
    except OSError:
        raise HTTPException(507, "恢复点未提交：磁盘不可写或空间不足，旧恢复点仍可使用") from None


@router.post("/sandbox/checkpoints")
async def save_checkpoint(request: Request):
    check_origin(request)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_DOCUMENT:
            raise HTTPException(413, "恢复文档超过 64 MiB")
    try:
        payload = Checkpoint.model_validate_json(body)
    except (ValidationError, ValueError):
        raise HTTPException(422, "恢复文档或清单无效") from None
    return await run_in_threadpool(commit_checkpoint, payload)


@router.get("/sandbox/checkpoints")
def list_checkpoints(request: Request):
    check_origin(request)
    with LOCK:
        entries = records()
        return {"checkpoints": entries[:20], "total": len(entries), "bytes": usage(),
                "limitBytes": MAX_STORAGE, "directory": str(folder())}


@router.get("/sandbox/checkpoints/{checkpoint_id}/bundle")
def recovery_bundle(request: Request, checkpoint_id: str):
    check_origin(request)
    if not re.fullmatch(r"[a-f0-9]{32}", checkpoint_id):
        raise HTTPException(404, "恢复点不存在")
    temporary = None
    try:
        with LOCK:
            record_path = stored_path("records", checkpoint_id + ".json")
            if not record_path.is_file():
                raise HTTPException(404, "恢复点不存在")
            if record_path.stat().st_size > 4096:
                raise ValueError()
            record = json.loads(record_path.read_bytes())
            if not re.fullmatch(HASH, record["documentHash"]):
                raise ValueError()
            document_path = stored_path("documents", record["documentHash"] + ".json")
            if document_path.stat().st_size > MAX_DOCUMENT:
                raise ValueError()
            content = document_path.read_bytes()
            if hashlib.sha256(content).hexdigest() != record["documentHash"]:
                raise HTTPException(422, "恢复项目文档校验失败，未改变当前项目")
            payload = Checkpoint.model_validate_json(content)
            validate_payload(payload)
            with tempfile.NamedTemporaryFile(dir=folder(), suffix=".geosandbox", prefix=".restore-", delete=False) as output:
                temporary = Path(output.name)
            with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=3) as archive:
                archive.writestr("manifest.json", encode(payload.manifest.model_dump()))
                archive.writestr("project.json", encode(payload.project))
                for asset in payload.manifest.assets:
                    archive.write(stored_path("assets", asset.sha256 + ".bin"), asset.path)
            if temporary.stat().st_size > MAX_EXPANDED:
                raise HTTPException(413, "恢复包超过 256 MiB，请拆分项目")
            return FileResponse(temporary, filename="GeoSandbox-recovery.geosandbox", media_type="application/zip",
                                background=BackgroundTask(temporary.unlink, missing_ok=True))
    except HTTPException:
        if temporary:
            temporary.unlink(missing_ok=True)
        raise
    except (OSError, ValueError, KeyError, TypeError, ValidationError):
        if temporary:
            temporary.unlink(missing_ok=True)
        raise HTTPException(422, "恢复点不可读或已损坏，未改变当前项目") from None
