"""Provide a small tiered cache with stale and failure windows."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Lock


@dataclass(frozen=True)
class CacheEntry[T]:
    """Single cache entry with timestamp metadata."""

    value: T
    updated_at: datetime


class TieredCache[T]:
    """Thread-safe cache with fresh/stale windows and failure cooldown."""

    def __init__(
        self,
        *,
        ttl_seconds: int,
        stale_seconds: int,
        failure_cooldown_seconds: int,
    ) -> None:
        """Initialize the cache with TTL, stale, and cooldown windows."""
        self._ttl_seconds = ttl_seconds
        self._stale_seconds = stale_seconds
        self._failure_cooldown_seconds = failure_cooldown_seconds
        self._entries: dict[str, CacheEntry[T]] = {}
        self._failures: dict[str, datetime] = {}
        self._lock = Lock()

    @staticmethod
    def _now() -> datetime:
        """Return the current monotonic timestamp."""
        return datetime.now(tz=UTC)

    def _get_entry(self, key: str) -> CacheEntry[T] | None:
        """Return the cached entry for a key without freshness checks."""
        with self._lock:
            return self._entries.get(key)

    def get_entry(self, key: str) -> CacheEntry[T] | None:
        """Return the cached entry for a key with timestamp metadata."""
        return self._get_entry(key)

    def set(self, key: str, value: T, *, now: datetime | None = None) -> None:
        """Store one value in the cache with a fresh timestamp."""
        timestamp = now or self._now()
        with self._lock:
            self._entries[key] = CacheEntry(value=value, updated_at=timestamp)
            self._failures.pop(key, None)

    def mark_failure(self, key: str, *, now: datetime | None = None) -> None:
        """Record a fetch failure timestamp for one cache key."""
        timestamp = now or self._now()
        with self._lock:
            self._failures[key] = timestamp

    def should_retry(self, key: str, *, now: datetime | None = None) -> bool:
        """Return whether to retry."""
        timestamp = now or self._now()
        cutoff = timestamp - timedelta(seconds=self._failure_cooldown_seconds)
        with self._lock:
            failure_at = self._failures.get(key)
        return not bool(failure_at and failure_at >= cutoff)

    def get_fresh(self, key: str, *, now: datetime | None = None) -> T | None:
        """Return a value only when it is still inside the fresh window."""
        entry = self._get_entry(key)
        if entry is None:
            return None

        timestamp = now or self._now()
        if entry.updated_at < timestamp - timedelta(seconds=self._ttl_seconds):
            return None
        return entry.value

    def get_stale(self, key: str, *, now: datetime | None = None) -> T | None:
        """Return a value while it remains inside the stale window."""
        entry = self._get_entry(key)
        if entry is None:
            return None

        timestamp = now or self._now()
        if entry.updated_at < timestamp - timedelta(seconds=self._stale_seconds):
            return None
        return entry.value
