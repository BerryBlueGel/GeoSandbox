"""Manual, revision-checked recovery cleanup. Raw assets/exports/jobs are read-only."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from . import sandbox_recovery as recovery
from .sandbox_storage import atomic_write, check_origin, data_root

router = APIRouter(prefix="/sandbox/storage")
GRACE_SECONDS = 24 * 3600
_ACTIVE: set[str] = set()
_PATTERNS = {"records": r"[a-f0-9]{32}\.json", "documents": r"[a-f0-9]{64}\.json", "assets": r"[a-f0-9]{64}\.bin"}


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    checkpointIds: list[str] = Field(default_factory=list, max_length=200)
    orphanedFiles: bool = True


class Execute(Selection):
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")


def _linked(path: Path):
    return path.is_symlink() or bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)


def _root():
    root = recovery.folder()
    if _linked(root) or root.resolve().parent != data_root().resolve():
        raise HTTPException(409, "恢复目录为链接或路径异常，已阻止清理")
    return root


def _owned(kind: str, name: str):
    if kind not in _PATTERNS or not re.fullmatch(_PATTERNS[kind], name):
        raise HTTPException(422, "清理文件标识无效")
    parent = _root() / kind
    path = parent / name
    if _linked(parent) or parent.resolve().parent != _root().resolve() or _linked(path) or path.resolve().parent != parent.resolve() or not path.is_file():
        raise HTTPException(409, "恢复文件路径已变化，已停止清理")
    return path


def _inventory():
    root, items, blocked = _root(), {}, []
    for kind, pattern in _PATTERNS.items():
        parent = root / kind
        if not parent.exists():
            continue
        if _linked(parent) or parent.resolve().parent != root.resolve():
            blocked.append("恢复区包含链接目录，清理已锁定")
            continue
        for path in sorted(parent.iterdir()):
            if _linked(path) or not path.is_file() or path.resolve().parent != parent.resolve():
                blocked.append("恢复区包含链接或非普通文件，清理已锁定")
                continue
            stat = path.stat()
            items[f"{kind}/{path.name}"] = {"bytes": stat.st_size, "mtime": stat.st_mtime_ns}
            if not path.name.startswith(".") and not re.fullmatch(pattern, path.name):
                blocked.append("恢复区存在无法识别的文件，清理已锁定")
    records_dir = root / "records"
    entries = [] if records_dir.exists() and _linked(records_dir) else recovery.records()
    if len(entries) != sum(key.startswith("records/") and not key.split("/")[1].startswith(".") for key in items):
        blocked.append("存在无法读取的恢复点记录，清理已锁定")
    documents = {}
    identities = {}
    for entry in entries:
        digest = entry["documentHash"]
        if digest in documents:
            continue
        try:
            path = _owned("documents", digest + ".json")
            if path.stat().st_size > recovery.MAX_DOCUMENT:
                raise ValueError()
            content = path.read_bytes()
            if hashlib.sha256(content).hexdigest() != digest:
                raise ValueError()
            payload = recovery.Checkpoint.model_validate_json(content)
            # Integrity of document/manifest and asset presence/size; no 2-GiB rehash.
            recovery.validate_payload(payload, verify_hashes=False)
            documents[digest] = {asset.sha256 for asset in payload.manifest.assets}
            identities[digest] = recovery.project_identity(payload.project.get("id"))
        except (OSError, ValueError, HTTPException, RecursionError):
            blocked.append("恢复文档或资源缺失/损坏，清理已锁定；请先核对恢复区")
    latest, legacy = {}, set()
    for entry in entries:  # Existing function is newest first.
        # Derive identity from the hash-checked document, not the mutable index or display name.
        identity = identities.get(entry["documentHash"])
        entry["projectId"] = identity
        if identity:
            latest.setdefault(identity, entry["id"])
        else:
            legacy.add(entry["id"])
    return items, entries, documents, set(latest.values()) | legacy, sorted(set(blocked))


def _plan(selection: Selection):
    items, entries, documents, protected, blocked = _inventory()
    selected = set(selection.checkpointIds)
    if len(selected) != len(selection.checkpointIds) or not selected <= {entry["id"] for entry in entries}:
        raise HTTPException(422, "选中的恢复点不存在或重复，请重新扫描")
    if selected & protected:
        raise HTTPException(409, "每个项目的最新恢复点和未记录项目 ID 的旧版恢复点都受到保护")
    retained = [entry for entry in entries if entry["id"] not in selected]
    live_documents = {entry["documentHash"] for entry in retained}
    live_assets = set().union(*(documents.get(digest, set()) for digest in live_documents))
    cutoff = time.time_ns() - GRACE_SECONDS * 1_000_000_000
    files, recent = [], 0
    for key, info in items.items():
        kind, name = key.split("/")
        if name.startswith("."):
            continue  # Pending uploads and restore bundles are never garbage collected here.
        remove = kind == "records" and name[:-5] in selected
        orphan = (kind == "documents" and name[:-5] not in live_documents) or (kind == "assets" and name[:-4] not in live_assets)
        if selection.orphanedFiles and orphan:
            if info["mtime"] <= cutoff:
                remove = True
            else:
                recent += 1
        if remove:
            files.append({"path": key, "bytes": info["bytes"], "reason": "选定旧恢复点" if kind == "records" else "未被保留恢复点引用且超过 24 小时"})
    more = len(files) > 500
    files = files[:500]  # Bounded, fully reviewable manual batches.
    if blocked:
        files = []
    signature = recovery.encode({"inventory": items, "selection": selection.model_dump(), "files": files, "blocked": blocked})
    return {"fingerprint": hashlib.sha256(signature).hexdigest(), "files": files, "reclaimableBytes": sum(item["bytes"] for item in files),
            "selectedCount": len(selected), "retainedCount": len(retained), "protectedCount": len(protected), "recentOrphans": recent, "hasMoreCandidates": more, "blocked": blocked}


def _tree_usage(root: Path):
    total, files, skipped = 0, 0, 0
    stack = [root]
    while stack:
        path = stack.pop()
        try:
            if not path.exists():
                continue
            if _linked(path) or not path.resolve().is_relative_to(data_root().resolve()):
                skipped += 1
            elif path.is_dir():
                stack.extend(path.iterdir())
            elif path.is_file():
                total += path.stat().st_size
                files += 1
        except OSError:
            skipped += 1
    return {"bytes": total, "files": files, "skipped": skipped}


@router.get("")
def overview(request: Request):
    check_origin(request)
    with recovery.LOCK:
        _, entries, _, protected, blocked = _inventory()
        categories = {kind: _tree_usage(data_root() / kind) for kind in ("checkpoints", "assets", "exports", "native-jobs", "logs")}
        disk = shutil.disk_usage(data_root())
        return {"directory": str(data_root()), "categories": categories, "recoveryBytes": recovery.usage(), "recoveryLimitBytes": recovery.MAX_STORAGE,
                "diskFreeBytes": disk.free, "diskTotalBytes": disk.total, "totalCheckpoints": len(entries), "protectedCount": len(protected), "blocked": blocked,
                "points": [{**entry, "protected": entry["id"] in protected} for entry in reversed(entries[-200:])], "graceHours": GRACE_SECONDS // 3600}


@router.post("/preview")
def preview(request: Request, selection: Selection):
    check_origin(request)
    with recovery.LOCK:
        return _plan(selection)


def _receipt_path(request_id: str):
    if not re.fullmatch(r"[a-f0-9]{32}", request_id):
        raise HTTPException(422, "清理回执编号无效")
    folder = _root() / "cleanup-receipts"
    folder.mkdir(exist_ok=True)
    if _linked(folder) or folder.resolve().parent != _root().resolve():
        raise HTTPException(409, "清理回执路径异常")
    path = folder / (request_id + ".json")
    if path.exists() and _linked(path):
        raise HTTPException(409, "清理回执路径异常")
    return path


def _write_receipt(path: Path, value: dict):
    atomic_write(path, lambda output: output.write(recovery.encode(value)))


@router.get("/receipts/{request_id}")
def receipt(request: Request, request_id: str):
    check_origin(request)
    with recovery.LOCK:
        path = _receipt_path(request_id)
        if not path.is_file():
            raise HTTPException(404, "尚无清理回执")
        value = json.loads(path.read_bytes())
        if value["status"] == "running" and request_id not in _ACTIVE:
            value.update(status="interrupted", removedBytes=None, removedFiles=None, message="服务曾中断，清理数量未确认；请重新扫描核对，不自动重跑")
            _write_receipt(path, value)
        return value


@router.post("/cleanup/{request_id}")
def cleanup(request: Request, request_id: str, command: Execute):
    check_origin(request)
    with recovery.LOCK:
        path = _receipt_path(request_id)
        if path.exists():
            value = receipt(request, request_id)
            if value["fingerprint"] != command.fingerprint:
                raise HTTPException(409, "该回执编号已用于另一份清单")
            return value
        plan = _plan(Selection(checkpointIds=command.checkpointIds, orphanedFiles=command.orphanedFiles))
        if plan["blocked"]:
            raise HTTPException(409, "；".join(plan["blocked"]))
        if plan["fingerprint"] != command.fingerprint:
            raise HTTPException(409, "恢复区或资源使用状态已变化，请重新预览；未执行清理")
        value = {"id": request_id, "fingerprint": command.fingerprint, "status": "running", "removedBytes": 0, "removedFiles": 0, "createdAt": time.time(), "message": "正在按预览清单清理"}
        _write_receipt(path, value)  # No destructive action without a durable receipt.
        _ACTIVE.add(request_id)
        try:
            # Remove selected record references before removing any unreferenced content.
            ordered = sorted(plan["files"], key=lambda item: (not item["path"].startswith("records/"), item["path"]))
            for item in ordered:
                kind, name = item["path"].split("/")
                target = _owned(kind, name)
                target.unlink()  # One validated ordinary file, never recursive deletion.
                value["removedFiles"] += 1
                value["removedBytes"] += item["bytes"]
            value.update(status="completed", message="清理完成；保留的恢复点和原始/导出文件未删除")
        except (OSError, HTTPException):
            value.update(status="partial", message="部分文件未能清理，已停止；请重新扫描，保留恢复点所需资源未删除")
        finally:
            _ACTIVE.discard(request_id)
        _write_receipt(path, value)
        return value
