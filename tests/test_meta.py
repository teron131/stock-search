from pathlib import Path

import stock_search.api.meta as meta


def test_stats_cache_generated_at_delegates_to_data_store_timestamp(monkeypatch) -> None:
    monkeypatch.setattr(meta, "stats_generated_at_iso", lambda: "2026-01-01T00:00:00+00:00")

    assert meta.stats_cache_generated_at(Path("ignored.json")) == "2026-01-01T00:00:00+00:00"
