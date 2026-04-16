from datetime import UTC, datetime, timedelta

from stock_search.cache import TieredCache


def build_cache() -> TieredCache[str]:
    return TieredCache[str](
        ttl_seconds=60,
        stale_seconds=300,
        failure_cooldown_seconds=120,
    )


def test_get_fresh_and_get_stale_follow_their_time_windows() -> None:
    cache = build_cache()
    updated_at = datetime(2026, 1, 1, tzinfo=UTC)
    cache.set("NVDA", "cached-row", now=updated_at)

    assert cache.get_fresh("NVDA", now=updated_at + timedelta(seconds=30)) == "cached-row"
    assert cache.get_fresh("NVDA", now=updated_at + timedelta(seconds=61)) is None
    assert cache.get_stale("NVDA", now=updated_at + timedelta(seconds=299)) == "cached-row"
    assert cache.get_stale("NVDA", now=updated_at + timedelta(seconds=301)) is None


def test_mark_failure_blocks_retries_until_cooldown_expires() -> None:
    cache = build_cache()
    failed_at = datetime(2026, 1, 1, tzinfo=UTC)
    cache.mark_failure("AAPL", now=failed_at)

    assert cache.should_retry("AAPL", now=failed_at + timedelta(seconds=30)) is False
    assert cache.should_retry("AAPL", now=failed_at + timedelta(seconds=121)) is True


def test_set_replaces_failure_state_with_a_new_cache_entry() -> None:
    cache = build_cache()
    now = datetime(2026, 1, 1, tzinfo=UTC)
    cache.mark_failure("MSFT", now=now)
    cache.set("MSFT", "fresh-value", now=now + timedelta(seconds=10))

    entry = cache.get_entry("MSFT")
    assert entry is not None
    assert entry.value == "fresh-value"
    assert cache.should_retry("MSFT", now=now + timedelta(seconds=10)) is True
