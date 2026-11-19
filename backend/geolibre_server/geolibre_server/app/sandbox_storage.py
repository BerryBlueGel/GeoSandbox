"""Shared local paths and atomic file commits for GeoSandbox."""
import os
import stat
import tempfile
from pathlib import Path

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, StrictBool

ALLOWED_ORIGINS = {"http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:4173", "http://localhost:4173"}


class ArchiveChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    archived: StrictBool


def local_entry(path: Path, *, directory: bool = False) -> Path | None:
    """Check an entry under a trusted parent without following filesystem links."""
    try:
        info = path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        return None
    if getattr(info, "st_file_attributes", 0) & 0x400:  # Windows reparse point
        return None
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    return path if expected(info.st_mode) else None


def data_root() -> Path:
    configured = os.environ.get("GEOSANDBOX_DATA_DIR")
    root = Path(configured) if configured else Path(__file__).resolve().parents[4] / ".geosandbox"
    root.mkdir(parents=True, exist_ok=True)
    return root


def check_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    configured = os.environ.get("GEOSANDBOX_PUBLIC_ORIGIN")
    allowed = {configured} if configured else ALLOWED_ORIGINS
    if origin and origin not in allowed:
        raise HTTPException(403, "Only the configured GeoSandbox origin may call this service")


def atomic_write(path: Path, write) -> None:
    """Publish only complete, flushed bytes; failure leaves the previous file untouched."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=".pending-", delete=False) as output:
            temporary = Path(output.name)
            write(output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
