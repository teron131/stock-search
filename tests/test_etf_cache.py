"""Regression tests for ETF cache reuse during portfolio assembly."""

from __future__ import annotations

from datetime import UTC, datetime
import unittest
from unittest.mock import patch

from stock_search.etf import classify_and_resolve_etfs, store_quote_type_in_stats


class EtfCacheTestCase(unittest.TestCase):
    """Verify ETF classification reuses cache and persists quote types."""

    def test_cached_holdings_without_sectors_still_skip_refetch(self) -> None:
        now = datetime.now(tz=UTC)
        positions = [{"ticker": "GLD", "quantity": 1.0}]
        stats_data = {
            "GLD": {
                "quote_type": "ETF",
                "etf_holdings": [{"ticker": "GLD", "name": "Gold", "weight": 100.0}],
                "etf_sectors": [],
                "etf_holdings_fetched_at": now.isoformat(),
            }
        }

        with patch("stock_search.etf._fetch_snapshot", side_effect=AssertionError("should not refetch")):
            result = classify_and_resolve_etfs(positions, stats_data, now)

        assert "GLD" in result.snapshot_by_ticker
        assert result.etf_refreshed_count == 0

    def test_unresolved_quote_type_is_persisted_into_stats(self) -> None:
        stats_data: dict[str, dict[str, object]] = {}

        changed = store_quote_type_in_stats(stats_data, "SPGI", is_etf=False)

        assert changed
        assert stats_data["SPGI"]["quote_type"] == "EQUITY"


if __name__ == "__main__":
    unittest.main()
