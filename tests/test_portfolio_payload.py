"""Regression tests for portfolio payload cache integration."""

from __future__ import annotations

import unittest

from stock_search.portfolio import _merge_live_results_into_stats_data, _portfolio_payload_data_source
from stock_search.stats_resolver import StatsResolutionResult


class PortfolioPayloadTestCase(unittest.TestCase):
    """Cover portfolio-level cache merge and source aggregation helpers."""

    def test_merge_live_results_preserves_unrelated_cached_fields(self) -> None:
        stats_data = {
            "AAPL": {
                "industry_labels": ["Technology"],
                "etf_holdings": [{"ticker": "AAPL", "weight": 5.0}],
                "price": 90.0,
            }
        }
        live_results = {
            "AAPL": StatsResolutionResult(
                row={"price": 100.0, "change": 1.5},
                data_source="live",
                families={},
            )
        }

        _merge_live_results_into_stats_data(stats_data=stats_data, live_results=live_results)

        assert stats_data["AAPL"]["price"] == 100.0
        assert stats_data["AAPL"]["change"] == 1.5
        assert stats_data["AAPL"]["industry_labels"] == ["Technology"]
        assert stats_data["AAPL"]["etf_holdings"] == [{"ticker": "AAPL", "weight": 5.0}]

    def test_payload_data_source_downgrades_when_any_row_is_cache_only(self) -> None:
        rows = [{"ticker": "AAPL"}, {"ticker": "MSFT"}]
        live_results = {
            "AAPL": StatsResolutionResult(
                row={"price": 100.0},
                data_source="live",
                families={},
            )
        }

        data_source = _portfolio_payload_data_source(
            rows=rows,
            live_results=live_results,
            include_live_market=True,
        )

        assert data_source == "live_with_cache_fallback"

    def test_payload_data_source_stays_live_when_all_rows_are_live(self) -> None:
        rows = [{"ticker": "AAPL"}, {"ticker": "MSFT"}]
        live_results = {
            "AAPL": StatsResolutionResult(row={"price": 100.0}, data_source="live", families={}),
            "MSFT": StatsResolutionResult(row={"price": 200.0}, data_source="live", families={}),
        }

        data_source = _portfolio_payload_data_source(
            rows=rows,
            live_results=live_results,
            include_live_market=True,
        )

        assert data_source == "live"


if __name__ == "__main__":
    unittest.main()
