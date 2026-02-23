from datetime import UTC, datetime
from pathlib import Path

from .data_store import stats_generated_at_iso


def now_iso() -> str:
    return datetime.now(tz=UTC).isoformat()


def stats_cache_generated_at(stats_path: Path) -> str | None:
    """Return `data/stats.json` mtime as ISO timestamp when available."""
    _ = stats_path
    return stats_generated_at_iso()
