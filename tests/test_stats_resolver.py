"""Regression tests for family-level stats resolution."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from stock_search import stats_resolver
from stock_search.indicators import StockIndicator
from stock_search.stats_families import FAMILY_TIMESTAMP_FIELD, STAT_FAMILIES, StatsFamily


def _family_values() -> dict[StatsFamily, dict[str, object]]:
    return {
        "market_data": {
            "price": 100.0,
            "change": 1.0,
            "change_percent_1d": 1.01,
        },
        "market_snapshot": {
            "name": "Apple Inc.",
            "quote_type": "EQUITY",
            "iv": 23.4,
            "rsi": 54.0,
            "change_percent_1m": 3.0,
            "change_percent_3m": 8.0,
            "change_percent_6m": 12.0,
            "change_percent_1y": 18.0,
            "change_percent_mtd": 1.5,
            "change_percent_ytd": 9.0,
        },
        "statistics": {
            "market_cap": 1_000_000_000.0,
            "pe": 25.0,
            "pe_forward": 21.0,
            "peg": 1.6,
            "beta": 1.1,
            "free_cash_flow": 123_000_000.0,
        },
        "financials": {
            "revenue_growth": 12.0,
            "gross_margin": 40.0,
            "debt_to_equity": 22.0,
        },
        "ratings": {
            "median_upside": 8.5,
            "ratings": {"buy": 15, "hold": 5, "sell": 1},
        },
    }


def _build_row(
    now: datetime,
    *,
    age_by_family: dict[StatsFamily, timedelta] | None = None,
    omit_families: set[StatsFamily] | None = None,
) -> dict[str, object]:
    age_by_family = age_by_family or {}
    omit_families = omit_families or set()
    row: dict[str, object] = {}
    for family in STAT_FAMILIES:
        if family in omit_families:
            continue
        row.update(_family_values()[family])
        fetched_at = now - age_by_family.get(family, timedelta(seconds=30))
        row[FAMILY_TIMESTAMP_FIELD[family]] = fetched_at.isoformat()
    return row


class StatsResolverTestCase(unittest.TestCase):
    """Cover resolver freshness, queueing, and persistence semantics."""

    def setUp(self) -> None:
        for cache in stats_resolver._FAMILY_CACHES.values():
            cache._entries.clear()
            cache._failures.clear()
        with stats_resolver._RUNNING_REFRESHES_LOCK:
            stats_resolver._RUNNING_REFRESHES.clear()

    def test_auto_accepts_fresh_cached_family(self) -> None:
        now = datetime.now(tz=UTC)
        row = _build_row(
            now,
            age_by_family={
                "market_data": timedelta(seconds=20),
                "market_snapshot": timedelta(minutes=10),
                "statistics": timedelta(hours=6),
                "financials": timedelta(hours=6),
                "ratings": timedelta(hours=6),
            },
        )
        with patch.object(stats_resolver, "_refresh_family", side_effect=AssertionError("should not refresh")):
            result = stats_resolver.resolve_ticker_stats("AAPL", mode="auto", persisted_row=row)

        assert result.families["statistics"].decision == "fresh"
        assert result.data_source == "live_with_cache_fallback"

    def test_auto_serves_stale_slow_family_and_queues_refresh(self) -> None:
        now = datetime.now(tz=UTC)
        row = _build_row(
            now,
            age_by_family={
                "market_data": timedelta(seconds=20),
                "market_snapshot": timedelta(minutes=10),
                "statistics": timedelta(hours=36),
                "financials": timedelta(hours=6),
                "ratings": timedelta(hours=6),
            },
        )
        with (
            patch.object(stats_resolver, "_queue_refresh", return_value=True) as queue_refresh,
            patch.object(stats_resolver, "_refresh_family", side_effect=AssertionError("should not inline refresh")),
        ):
            result = stats_resolver.resolve_ticker_stats("AAPL", mode="auto", persisted_row=row)

        assert result.families["statistics"].decision == "stale_served"
        assert result.families["statistics"].queued_refresh
        queue_refresh.assert_called_once_with("AAPL", "statistics")

    def test_auto_refreshes_stale_market_data_inline(self) -> None:
        now = datetime.now(tz=UTC)
        row = _build_row(
            now,
            age_by_family={
                "market_data": timedelta(minutes=2),
                "market_snapshot": timedelta(minutes=10),
                "statistics": timedelta(hours=6),
                "financials": timedelta(hours=6),
                "ratings": timedelta(hours=6),
            },
        )
        outcome = stats_resolver.RefreshOutcome(
            family_rows={
                "market_data": {
                    "price": 101.0,
                    "change": 2.0,
                    "change_percent_1d": 2.02,
                }
            },
            family_timestamps={"market_data": now},
            extra_fields={},
        )
        with (
            patch.object(stats_resolver, "_refresh_family", return_value=outcome) as refresh_family,
            patch.object(stats_resolver, "load_stats_map", return_value={"AAPL": row}),
            patch.object(stats_resolver, "save_stats_map"),
        ):
            result = stats_resolver.resolve_ticker_stats("AAPL", mode="auto", persisted_row=row)

        assert result.families["market_data"].decision == "inline_refresh"
        assert result.row["price"] == 101.0
        assert refresh_family.call_count == 1
        assert refresh_family.call_args.args[1] == "market_data"

    def test_auto_fetches_missing_slow_family_inline(self) -> None:
        now = datetime.now(tz=UTC)
        row = _build_row(
            now,
            age_by_family={
                "market_data": timedelta(seconds=20),
                "market_snapshot": timedelta(minutes=10),
                "statistics": timedelta(hours=6),
                "financials": timedelta(hours=6),
            },
            omit_families={"ratings"},
        )
        outcome = stats_resolver.RefreshOutcome(
            family_rows={
                "ratings": {
                    "median_upside": 9.0,
                    "ratings": {"buy": 18, "hold": 2, "sell": 0},
                }
            },
            family_timestamps={"ratings": now},
            extra_fields={},
        )
        with (
            patch.object(stats_resolver, "_refresh_family", return_value=outcome) as refresh_family,
            patch.object(stats_resolver, "load_stats_map", return_value={"AAPL": row}),
            patch.object(stats_resolver, "save_stats_map"),
        ):
            result = stats_resolver.resolve_ticker_stats("AAPL", mode="auto", persisted_row=row)

        assert result.families["ratings"].decision == "inline_refresh"
        assert result.row["median_upside"] == 9.0
        assert refresh_family.call_count == 1
        assert refresh_family.call_args.args[1] == "ratings"

    def test_cache_mode_never_fetches_or_queues(self) -> None:
        now = datetime.now(tz=UTC)
        row = _build_row(
            now,
            age_by_family={family: timedelta(days=3) for family in STAT_FAMILIES},
        )
        with (
            patch.object(stats_resolver, "_queue_refresh", side_effect=AssertionError("should not queue")),
            patch.object(stats_resolver, "_refresh_family", side_effect=AssertionError("should not fetch")),
        ):
            result = stats_resolver.resolve_ticker_stats("AAPL", mode="cache", persisted_row=row)

        assert result.data_source == "cache"
        assert result.families["market_data"].source_tier == "l2"

    def test_live_mode_raises_when_refresh_fails(self) -> None:
        now = datetime.now(tz=UTC)
        row = _build_row(now)
        try:
            with (
                patch.object(stats_resolver, "_refresh_family", side_effect=RuntimeError("boom")),
                patch.object(stats_resolver.logger, "exception"),
            ):
                stats_resolver.resolve_ticker_stats("AAPL", mode="live", persisted_row=row)
        except RuntimeError:
            pass
        else:
            raise AssertionError("expected live mode to raise when refresh fails")

    def test_family_scoped_write_through_preserves_other_families(self) -> None:
        now = datetime.now(tz=UTC)
        existing = _build_row(now)
        outcome = stats_resolver.RefreshOutcome(
            family_rows={
                "market_data": {
                    "price": 200.0,
                    "change": 3.0,
                    "change_percent_1d": 1.5,
                }
            },
            family_timestamps={"market_data": now},
            extra_fields={},
        )
        saved: dict[str, dict[str, object]] = {}

        with (
            patch.object(stats_resolver, "load_stats_map", return_value={"AAPL": existing}),
            patch.object(stats_resolver, "save_stats_map", side_effect=lambda payload: saved.update(payload)),
        ):
            merged = stats_resolver._persist_refresh_outcome("AAPL", outcome)

        assert merged["ratings"] == existing["ratings"]
        assert merged["price"] == 200.0
        assert saved["AAPL"]["statistics_fetched_at"] == existing["statistics_fetched_at"]

    def test_same_page_extra_fields_update_without_advancing_other_family_timestamp(self) -> None:
        now = datetime.now(tz=UTC)
        existing = _build_row(now)
        outcome = stats_resolver.RefreshOutcome(
            family_rows={
                "statistics": {
                    "market_cap": 2_000_000_000.0,
                    "pe": 20.0,
                    "pe_forward": 18.0,
                    "peg": 1.4,
                    "beta": 1.0,
                    "free_cash_flow": 456_000_000.0,
                }
            },
            family_timestamps={"statistics": now},
            extra_fields={
                "gross_margin": 45.0,
                "debt_to_equity": 18.0,
                "rsi": 61.0,
            },
        )

        with (
            patch.object(stats_resolver, "load_stats_map", return_value={"AAPL": existing}),
            patch.object(stats_resolver, "save_stats_map"),
        ):
            merged = stats_resolver._persist_refresh_outcome("AAPL", outcome)

        assert merged["gross_margin"] == 45.0
        assert merged["debt_to_equity"] == 18.0
        assert merged["rsi"] == 61.0
        assert merged["financials_fetched_at"] == existing["financials_fetched_at"]
        assert merged["market_snapshot_fetched_at"] == existing["market_snapshot_fetched_at"]

    def test_queue_refresh_dedupes_same_ticker_family(self) -> None:
        submit_result = SimpleNamespace()
        with patch.object(stats_resolver._REFRESH_EXECUTOR, "submit", return_value=submit_result):
            first = stats_resolver._queue_refresh("AAPL", "statistics")
            second = stats_resolver._queue_refresh("AAPL", "statistics")

        assert first
        assert not second

    def test_background_refresh_success_updates_persisted_timestamp(self) -> None:
        now = datetime.now(tz=UTC)
        outcome = stats_resolver.RefreshOutcome(
            family_rows={
                "statistics": {
                    "market_cap": 3_000_000_000.0,
                    "pe": 30.0,
                    "pe_forward": 24.0,
                    "peg": 1.2,
                    "beta": 0.9,
                    "free_cash_flow": 789_000_000.0,
                }
            },
            family_timestamps={"statistics": now},
            extra_fields={},
        )
        saved: dict[str, dict[str, object]] = {}

        def submit_now(callback):
            callback()
            return SimpleNamespace()

        with (
            patch.object(stats_resolver, "_refresh_family", return_value=outcome),
            patch.object(stats_resolver, "load_stats_map", return_value={}),
            patch.object(stats_resolver, "save_stats_map", side_effect=lambda payload: saved.update(payload)),
            patch.object(stats_resolver._REFRESH_EXECUTOR, "submit", side_effect=submit_now),
        ):
            queued = stats_resolver._queue_refresh("AAPL", "statistics")

        assert queued
        assert saved["AAPL"]["statistics_fetched_at"] == now.isoformat()

    def test_background_refresh_failure_marks_cooldown(self) -> None:
        now = datetime.now(tz=UTC)

        def submit_now(callback):
            callback()
            return SimpleNamespace()

        with (
            patch.object(stats_resolver, "_refresh_family", side_effect=RuntimeError("boom")),
            patch.object(stats_resolver._REFRESH_EXECUTOR, "submit", side_effect=submit_now),
            patch.object(stats_resolver.logger, "exception"),
        ):
            queued = stats_resolver._queue_refresh("AAPL", "statistics")

        assert queued
        assert not stats_resolver._FAMILY_CACHES["statistics"].should_retry("AAPL", now=now)

    def test_statistics_family_row_skips_yahoo_when_scraped_values_exist(self) -> None:
        stats = SimpleNamespace(
            market_cap=1_000_000_000.0,
            pe=25.0,
            pe_forward=21.0,
            peg=1.5,
            beta=1.1,
            free_cash_flow=123_000_000.0,
        )

        class FailIfCalledYahoo:
            def get_quote_type(self):
                raise AssertionError("should not fetch yahoo quote type")

            def get_market_cap(self):
                raise AssertionError("should not fetch yahoo market cap")

            def get_pe_trailing(self):
                raise AssertionError("should not fetch yahoo pe")

            def get_forward_pe_ntm(self):
                raise AssertionError("should not fetch yahoo forward pe")

            def get_peg(self):
                raise AssertionError("should not fetch yahoo peg")

            def get_beta(self):
                raise AssertionError("should not fetch yahoo beta")

            def get_free_cash_flow_in_quote_currency(self):
                raise AssertionError("should not fetch yahoo free cash flow")

        row = stats_resolver._statistics_family_row(stats, FailIfCalledYahoo())

        assert row["pe_forward"] == 21.0
        assert row["market_cap"] == 1_000_000_000.0

    def test_stock_indicator_prefers_scraped_rsi_over_yahoo(self) -> None:
        with (
            patch("stock_search.indicators.YahooFinanceSource") as yahoo_source,
            patch("stock_search.indicators.StockAnalysisSource") as stockanalysis_source,
        ):
            yahoo = yahoo_source.return_value
            yahoo.ticker = "AAPL"
            yahoo.get_indicators_snapshot.return_value = SimpleNamespace(rsi=41.0)

            stockanalysis = stockanalysis_source.return_value
            stockanalysis.get_indicators_snapshot.return_value = SimpleNamespace(rsi=58.0)

            indicator = StockIndicator("AAPL")

            assert indicator.rsi == 58.0
            yahoo.get_indicators_snapshot.assert_not_called()


if __name__ == "__main__":
    unittest.main()
