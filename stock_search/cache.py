from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Lock
from typing import Generic, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class CacheEntry(Generic[T]):
    """Single cache entry with timestamp metadata."""

    value: T
    updated_at: datetime


class TieredCache(Generic[T]):
    """Thread-safe cache with fresh/stale windows and failure cooldown."""

    def __init__(
        self,
        *,
        ttl_seconds: int,
        stale_seconds: int,
        failure_cooldown_seconds: int,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._stale_seconds = stale_seconds
        self._failure_cooldown_seconds = failure_cooldown_seconds
        self._entries: dict[str, CacheEntry[T]] = {}
        self._failures: dict[str, datetime] = {}
        self._lock = Lock()

    @staticmethod
    def _now() -> datetime:
        return datetime.now(tz=UTC)

    def _get_entry(self, key: str) -> CacheEntry[T] | None:
        with self._lock:
            return self._entries.get(key)

    def set(self, key: str, value: T, *, now: datetime | None = None) -> None:
        timestamp = now or self._now()
        with self._lock:
            self._entries[key] = CacheEntry(value=value, updated_at=timestamp)
            self._failures.pop(key, None)

    def mark_failure(self, key: str, *, now: datetime | None = None) -> None:
        timestamp = now or self._now()
        with self._lock:
            self._failures[key] = timestamp

    def should_retry(self, key: str, *, now: datetime | None = None) -> bool:
        timestamp = now or self._now()
        cutoff = timestamp - timedelta(seconds=self._failure_cooldown_seconds)
        with self._lock:
            failure_at = self._failures.get(key)
        return not bool(failure_at and failure_at >= cutoff)

    def get_fresh(self, key: str, *, now: datetime | None = None) -> T | None:
        entry = self._get_entry(key)
        if entry is None:
            return None

        timestamp = now or self._now()
        if entry.updated_at < timestamp - timedelta(seconds=self._ttl_seconds):
            return None
        return entry.value

    def get_stale(self, key: str, *, now: datetime | None = None) -> T | None:
        entry = self._get_entry(key)
        if entry is None:
            return None

        timestamp = now or self._now()
        if entry.updated_at < timestamp - timedelta(seconds=self._stale_seconds):
            return None
        return entry.value
