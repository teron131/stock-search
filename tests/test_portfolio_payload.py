"""Regression tests for portfolio payload cache integration."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from stock_search.portfolio import (
    _load_payload_inputs,
    _merge_live_results_into_stats_data,
    _portfolio_payload_data_source,
)
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

    def test_load_payload_inputs_limits_stock_family_reads_when_cached_universe_is_disabled(self) -> None:
        portfolio_data = [
            {"ticker": "nvda", "quantity": 10},
            {"ticker": " msft ", "quantity": 5},
        ]
        stock_families = (
            {"NVDA": {"price": 1.0}, "MSFT": {"price": 2.0}},
            {"NVDA": {"overall_score": 9.0}},
        )

        with (
            patch("stock_search.portfolio.load_positions_store", return_value=portfolio_data),
            patch("stock_search.portfolio.load_stock_families", return_value=stock_families) as load_stock_families,
        ):
            payload_inputs = _load_payload_inputs(
                portfolio_path=None,
                stats_path=None,
                eval_path=None,
                include_cached_universe=False,
            )

        load_stock_families.assert_called_once_with(tickers=["NVDA", "MSFT"])
        assert payload_inputs.held_tickers == ["NVDA", "MSFT"]

    def test_load_payload_inputs_reads_full_stock_universe_when_requested(self) -> None:
        with (
            patch("stock_search.portfolio.load_positions_store", return_value=[]),
            patch("stock_search.portfolio.load_stock_families", return_value=({}, {})) as load_stock_families,
        ):
            _load_payload_inputs(
                portfolio_path=None,
                stats_path=None,
                eval_path=None,
                include_cached_universe=True,
            )

        load_stock_families.assert_called_once_with(tickers=None)


if __name__ == "__main__":
    unittest.main()
