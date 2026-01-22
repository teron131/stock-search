from __future__ import annotations

import json
from pathlib import Path
from typing import Any, TypeVar

T = TypeVar("T")


def load_json[T](path: str | Path, default: T) -> T:
    path = Path(path)
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def write_json(path: str | Path, data: Any, *, indent: int = 2) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=indent), encoding="utf-8")
