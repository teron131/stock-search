from datetime import UTC, datetime
from pathlib import Path


def now_iso() -> str:
    return datetime.now(tz=UTC).isoformat()


def stats_cache_generated_at(stats_path: Path) -> str | None:
    """Return `data/stats.json` mtime as ISO timestamp when available."""
    if not stats_path.exists():
        return None
    modified_at = datetime.fromtimestamp(stats_path.stat().st_mtime, tz=UTC)
    return modified_at.isoformat()
