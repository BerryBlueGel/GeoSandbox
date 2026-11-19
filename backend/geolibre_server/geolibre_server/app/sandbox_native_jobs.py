"""Durable import receipts around GeoLibre's existing subprocess job runner.

Only this module supplies scripts, interpreter and filesystem paths. The HTTP
interface accepts data and CRS options, never arbitrary commands or paths.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse

from . import conversion
from .sandbox_storage import ArchiveChange, atomic_write, check_origin, data_root, local_entry

router = APIRouter(prefix="/sandbox/native-jobs")
_LOCK = threading.RLock()
_ACTIVE: set[str] = set()
_TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}
_SCRIPT = """import sys, json
params = json.loads(sys.argv[1])
sys.path.insert(0, params['package_root'])
from geolibre_server.app.sandbox_native_worker import run
run(params)
"""
MAX_INPUT = 128 * 1024 * 1024
TIMEOUT = 120


def _folder(job_id: str) -> Path:
    try:
        if str(uuid.UUID(job_id)) != job_id:
            raise ValueError()
    except ValueError:
        raise HTTPException(422, "任务编号无效") from None
    return data_root() / "native-jobs" / job_id


def _write(folder: Path, record: dict):
    record["updatedAt"] = time.time()
    atomic_write(folder / "job.json", lambda output: output.write(json.dumps(record, ensure_ascii=False).encode()))


def _load(folder: Path):
    try:
        return json.loads((folder / "job.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise HTTPException(404, "后台任务不存在") from None


def _public(record: dict):
    return {key: value for key, value in record.items() if key not in {"workerPid", "inputSuffix"}}


def _sync(folder: Path):
    """Call under _LOCK; terminal status requires the managed process to be reaped."""
    record = _load(folder)
    before = dict(record)
    job_id = record["id"]
    if record["status"] in _TERMINAL:
        return record
    if job_id not in _ACTIVE:
        record.update(status="interrupted", stage="服务已重启，任务中断；请重新选择原文件", processStopped=None)
        _write(folder, record)
        return record
    with conversion._JOBS_LOCK:
        state = conversion._JOBS.get(job_id)
        process = conversion._PROCESSES.get(job_id)
        stopped = state is not None and state.status in {"succeeded", "failed", "cancelled"} and process is None
        status = state.status if state else "pending"
        error = state.error if state else None
        messages = list(state.messages) if state else []
        result = state.result if state else None
        if process:
            record["workerPid"] = process.pid
    if record.get("cancelRequested"):
        record.update(status="cancelling", stage="正在停止后台计算进程")
    elif status == "running":
        stage = next((m for m in reversed(messages) if m in {"读取图层与 CRS", "读取并转换数据", "写入转换结果"}), "启动 GIS 计算进程")
        record.update(status="running", stage=stage)
    if stopped:
        record["processStopped"] = True
        if record.get("cancelRequested") or status == "cancelled":
            record.update(status="cancelled", stage="已停止计算，结果未应用")
        elif status == "succeeded":
            try:
                if result != {"ready": True}:
                    raise ValueError("missing worker receipt")
                path = folder / "result.json"
                if path.stat().st_size > 64 * 1024 * 1024:
                    raise ValueError("result too large")
                original = folder / ("input" + record["inputSuffix"])
                if record.get("operation") == "inspect":
                    encoded = path.read_bytes()
                    original.unlink(missing_ok=True)  # Temporary inspection copy; the browser still holds the source.
                    stage = "图层与 CRS 检查完成"
                else:
                    output = json.loads(path.read_text(encoding="utf-8"))
                    assets = data_root() / "assets"
                    assets.mkdir(exist_ok=True)
                    asset_name = job_id.replace("-", "") + record["inputSuffix"]
                    # Fixed owned paths on the same volume; no user-supplied path.
                    os.replace(original, assets / asset_name)
                    output.update(assetUrl=f"/sandbox-api/assets/{asset_name}", filename=record["filename"])
                    if record["kind"] == "raster":
                        preview = job_id.replace("-", "") + ".png"
                        os.replace(folder / "preview.png", assets / preview)
                        output["previewUrl"] = f"/sandbox-api/assets/{preview}"
                    encoded = json.dumps(output, ensure_ascii=False, allow_nan=False).encode()
                    atomic_write(path, lambda target: target.write(encoded))
                    stage = "计算完成，结果可读取"
                record.update(status="succeeded", stage=stage, resultSha256=hashlib.sha256(encoded).hexdigest())
            except Exception:
                record.update(status="failed", stage="结果提交失败，请重新选择原文件")
        else:
            stage = f"GIS 处理超过 {TIMEOUT:g} 秒，已停止；请拆分数据后重试" if error == "Conversion timed out." else error or "GIS 处理失败，请检查格式与坐标系"
            record.update(status="failed", stage=stage)
        _ACTIVE.discard(job_id)
    if record != before:
        _write(folder, record)
    return record


def _monitor(folder: Path):
    while True:
        with _LOCK:
            record = _sync(folder)
        if record["status"] in _TERMINAL:
            return
        time.sleep(0.1)


def _environment():
    # A GIS worker needs system/runtime settings, never API keys or chat config.
    allowed = {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "GDAL_DATA", "GDAL_DRIVER_PATH"}
    env = {k: v for k, v in os.environ.items() if k.upper() in allowed}
    env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    return env


@router.post("/{job_id}")
def submit(job_id: str, request: Request, file: UploadFile = File(...), kind: str = Form(...), source_crs: str = Form(""), force_crs: bool = Form(False), operation: str = Form("import"), layer_crs: str = Form("")):
    check_origin(request)
    folder = _folder(job_id)
    suffix = Path(file.filename or "").suffix.lower()
    allowed = {"vector": {".gpkg", ".zip", ".geojson", ".json"}, "raster": {".tif", ".tiff"}}
    if kind not in allowed or suffix not in allowed[kind]:
        raise HTTPException(422, "不支持的原生 GIS 导入格式")
    if len(source_crs) > 16384:
        raise HTTPException(422, "源 CRS 过长")
    if operation not in {"import", "inspect"} or (operation == "inspect" and kind != "vector"):
        raise HTTPException(422, "不支持的 GIS 任务类型")
    overrides = {}
    if layer_crs:
        try:
            if kind != "vector" or operation != "import" or len(layer_crs) > 65536:
                raise ValueError()
            overrides = json.loads(layer_crs)
            if not isinstance(overrides, dict) or len(overrides) > 32 or any(
                not name.strip() or not isinstance(value, str) or not value.strip() or len(value) > 16384
                for name, value in overrides.items()
            ):
                raise ValueError()
        except (ValueError, RecursionError):
            raise HTTPException(422, "逐图层 CRS 参数无效") from None
    with _LOCK:
        if (folder / "job.json").exists():
            return _public(_sync(folder))  # Never start twice after a lost POST acknowledgment.
        if len(_ACTIVE) >= 2:
            raise HTTPException(429, "同时最多运行 2 个原生 GIS 导入任务")
        filename = re.sub(r'[<>:"/\\\x00-\x1f]', "_", file.filename or "data")[:160]
        record = dict(id=job_id, kind=kind, operation=operation, filename=filename, inputSuffix=suffix, status="pending", stage="暂存待处理文件", createdAt=time.time(), processStopped=False)
        _write(folder, record)
        _ACTIVE.add(job_id)
    try:
        total, digest = 0, hashlib.sha256()
        def copy(target):
            nonlocal total
            while chunk := file.file.read(1024 * 1024):
                with _LOCK:
                    if _load(folder).get("cancelRequested"):
                        raise InterruptedError()
                total += len(chunk)
                if total > MAX_INPUT:
                    raise HTTPException(413, "原始文件超过 128 MiB，请拆分后导入")
                target.write(chunk)
                digest.update(chunk)
        atomic_write(folder / ("input" + suffix), copy)
        with _LOCK:
            record = _load(folder)
            if record.get("cancelRequested"):
                raise InterruptedError()
            record.update(inputBytes=total, inputSha256=digest.hexdigest())
            _write(folder, record)
            params = dict(kind=kind, operation=operation, filename=filename, input_path=str(folder / ("input" + suffix)), output_path=str(folder / "result.json"), preview_path=str(folder / "preview.png"), source_crs=source_crs, force_crs=force_crs, parent_pid=os.getpid(), package_root=str(Path(__file__).resolve().parents[2]))
            if overrides:
                options = folder / "layer-crs.json"
                atomic_write(options, lambda target: target.write(json.dumps(overrides, ensure_ascii=False).encode()))
                params["layer_crs_path"] = str(options)
            conversion._start_job("sandbox-native-import", _SCRIPT, params, "result", job_id=job_id, python=sys.executable, environment=_environment(), timeout_secs=TIMEOUT)
            threading.Thread(target=_monitor, args=(folder,), daemon=True).start()
            return _public(_sync(folder))
    except Exception as exc:
        with _LOCK:
            record = _load(folder)
            with conversion._JOBS_LOCK:
                started = job_id in conversion._JOBS
            if started:
                conversion._cancel_job(job_id)
                record.update(cancelRequested=True, status="cancelling", stage="任务启动异常，正在停止计算进程")
            else:
                record.update(status="cancelled" if isinstance(exc, InterruptedError) else "failed", stage="已取消，计算未启动" if isinstance(exc, InterruptedError) else "任务启动失败，请重试", processStopped=True)
            _write(folder, record)
            if not started:
                _ACTIVE.discard(job_id)
        if isinstance(exc, InterruptedError):
            return _public(record)
        raise
    finally:
        file.file.close()


@router.get("")
def list_jobs(request: Request, archived: bool = False, offset: int | None = Query(None, ge=0)):
    check_origin(request)
    with _LOCK:
        root = local_entry(data_root() / "native-jobs", directory=True)
        folders = []
        for folder in root.iterdir() if root else ():
            if not local_entry(folder, directory=True) or not local_entry(folder / "job.json"):
                continue
            try:
                if str(uuid.UUID(folder.name)) != folder.name:
                    continue
                info = (folder / "job.json").stat()
                if info.st_size <= 16384:
                    folders.append((folder.name in _ACTIVE, info.st_mtime, folder.name))
            except (OSError, ValueError):
                continue
        entries = []
        for _, _, job_id in sorted(folders, reverse=True):
            folder = root / job_id
            try:
                record = _load(folder)
                if record["id"] != job_id or record["status"] not in _TERMINAL | {"pending", "running", "cancelling"}:
                    continue
                if bool(record.get("archivedAt")) == archived:
                    entries.append(folder)
                    if offset is None and len(entries) == 20:
                        break
            except (OSError, ValueError, KeyError, TypeError, HTTPException):
                continue
        start = offset or 0
        response = {"jobs": [_public(_sync(folder)) for folder in entries[start:start + 20]]}
        if offset is not None:
            response["total"] = len(entries)
        return response


@router.patch("/{job_id}/archive")
def archive_job(job_id: str, request: Request, change: ArchiveChange):
    check_origin(request)
    with _LOCK:
        folder = _folder(job_id)
        if not local_entry(folder.parent, directory=True) or not local_entry(folder, directory=True) or not local_entry(folder / "job.json"):
            raise HTTPException(404, "后台任务不存在")
        record = _sync(folder)
        if record["status"] not in _TERMINAL or job_id in _ACTIVE:
            raise HTTPException(409, "请等待任务完成或停止后再归档")
        if bool(record.get("archivedAt")) != change.archived:
            if change.archived:
                record["archivedAt"] = time.time()
            else:
                record.pop("archivedAt", None)
            try:
                _write(folder, record)
            except OSError:
                raise HTTPException(507, "归档标记未更新，请检查磁盘后刷新列表") from None
        return {"archived": change.archived}


@router.get("/{job_id}")
def get_job(job_id: str, request: Request):
    check_origin(request)
    with _LOCK:
        return _public(_sync(_folder(job_id)))


@router.get("/{job_id}/result")
def get_result(job_id: str, request: Request):
    check_origin(request)
    with _LOCK:
        folder = _folder(job_id)
        record = _sync(folder)
        if record["status"] != "succeeded":
            raise HTTPException(409, "计算尚未成功完成，结果不可读取")
        path = folder / "result.json"
        if not path.is_file() or path.stat().st_size > 64 * 1024 * 1024 or hashlib.sha256(path.read_bytes()).hexdigest() != record["resultSha256"]:
            raise HTTPException(409, "结果校验失败，请重新导入")
    return FileResponse(path, media_type="application/json")


@router.post("/{job_id}/cancel")
def cancel(job_id: str, request: Request):
    check_origin(request)
    folder = _folder(job_id)
    with _LOCK:
        if not (folder / "job.json").exists():
            # Cancellation may reach us before the multipart POST finishes.
            record = dict(id=job_id, kind="unknown", filename="尚未提交的任务", status="cancelled", stage="已取消，计算未启动", createdAt=time.time(), processStopped=True, cancelRequested=True)
            _write(folder, record)
            return _public(record)
        record = _sync(folder)
        if record["status"] in _TERMINAL:
            return _public(record)
        record.update(cancelRequested=True, status="cancelling", stage="正在停止后台计算进程")
        _write(folder, record)
        conversion._cancel_job(job_id)
    # The caller can poll if the subprocess takes longer to reap.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        with _LOCK:
            record = _sync(folder)
        if record["status"] in _TERMINAL:
            break
        time.sleep(0.05)
    return _public(record)
