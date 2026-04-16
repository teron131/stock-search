"""Provide timestamp helpers for API metadata."""

from datetime import UTC, datetime
from pathlib import Path

from .data_store import stats_generated_at_iso


def now_iso() -> str:
    """Return the current UTC time in ISO format."""
    return datetime.now(tz=UTC).isoformat()


def stats_cache_generated_at(stats_path: Path | None = None) -> str | None:
    """Return the persisted stats generation timestamp when available."""
    _ = stats_path
    return stats_generated_at_iso()
