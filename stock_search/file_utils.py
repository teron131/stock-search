"""Read and write JSON files for repo data stores."""

from __future__ import annotations

from contextlib import suppress
import json
import os
from pathlib import Path
import tempfile
from typing import Any, TypeVar

T = TypeVar("T")


def load_json[T](path: str | Path, default: T) -> T:
    """Load JSON data from disk with a fallback default."""
    path = Path(path)
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def write_json(path: str | Path, data: Any, *, indent: int = 2) -> None:
    """Write JSON data to disk with stable formatting."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=indent)

    # Write atomically to avoid readers observing partial files during concurrent
    # reads while an update is being persisted.
    fd: int | None = None
    tmp_path: Path | None = None
    try:
        fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        tmp_path = Path(tmp_name)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            fd = None
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())

        os.replace(tmp_path, path)
    finally:
        if fd is not None:
            with suppress(OSError):
                os.close(fd)
        if tmp_path is not None and tmp_path.exists():
            with suppress(OSError):
                tmp_path.unlink()
