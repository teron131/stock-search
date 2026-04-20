"""Resolve ticker stats with family-level freshness and layered caches."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
import logging
from threading import Lock, RLock
from typing import Any, Literal

from stock_search.api.data_store import load_stats_map, load_stats_row, upsert_stats_row
from stock_search.cache import TieredCache
from stock_search.common_utils import normalize_ticker_symbol
from stock_search.config import CacheConfig, PortfolioConfig
from stock_search.data_sources.stockanalysis import (
    StockAnalysisFinancials,
    StockAnalysisSource,
    StockAnalysisStatistics,
)
from stock_search.data_sources.stockanalysis.parsing import to_percent
from stock_search.data_sources.yahoofinance import ETF_QUOTE_TYPE, YahooFinanceSource
from stock_search.stats_families import BLOCKING_AUTO_FAMILIES, FAMILY_FIELDS, FAMILY_TIMESTAMP_FIELD, STAT_FAMILIES, StatsFamily, family_timestamp_fields

logger = logging.getLogger(__name__)

StatsResolutionMode = Literal["auto", "live", "cache"]
FamilyDecision = Literal["fresh", "stale_served", "inline_refresh", "missing"]


@dataclass(frozen=True)
class FamilyCachePolicy:
    """Cache windows and retry policy for one stat family."""

    fresh_window: timedelta
    stale_window: timedelta
    failure_cooldown: timedelta


@dataclass(frozen=True)
class FamilyResolution:
    """Resolved outcome for one family."""

    family: StatsFamily
    row: dict[str, Any]
    decision: FamilyDecision
    source_tier: Literal["l1", "l2", "live", "missing"]
    timestamp: datetime | None = None
    queued_refresh: bool = False
    extra_fields: dict[str, Any] = field(default_factory=dict)
    refresh_outcome: RefreshOutcome | None = None


@dataclass(frozen=True)
class StatsResolutionResult:
    """Resolved row plus metadata about the cache/live path used."""

    row: dict[str, Any]
    data_source: Literal["cache", "live", "live_with_cache_fallback"]
    families: dict[StatsFamily, FamilyResolution]


@dataclass(frozen=True)
class RefreshOutcome:
    """Family refresh payload plus extra fields learned from the same fetch."""

    family_rows: dict[StatsFamily, dict[str, Any]]
    family_timestamps: dict[StatsFamily, datetime]
    extra_fields: dict[str, Any]


@dataclass(frozen=True)
class CachedFamilySnapshot:
    """Best available cached snapshot for one family."""

    source_tier: Literal["l1", "l2", "missing"]
    row: dict[str, Any]
    timestamp: datetime | None
    is_fresh: bool
    is_stale: bool
    present: bool


FAMILY_POLICIES: dict[StatsFamily, FamilyCachePolicy] = {
    "market_data": FamilyCachePolicy(
        fresh_window=timedelta(seconds=CacheConfig.HISTORY_TTL_SECONDS),
        stale_window=timedelta(seconds=CacheConfig.HISTORY_STALE_SECONDS),
        failure_cooldown=timedelta(seconds=CacheConfig.HISTORY_FAILURE_COOLDOWN_SECONDS),
    ),
    "market_snapshot": FamilyCachePolicy(
        fresh_window=timedelta(seconds=CacheConfig.INFO_TTL_SECONDS),
        stale_window=timedelta(seconds=CacheConfig.INFO_STALE_SECONDS),
        failure_cooldown=timedelta(seconds=CacheConfig.INFO_FAILURE_COOLDOWN_SECONDS),
    ),
    "statistics": FamilyCachePolicy(
        fresh_window=timedelta(days=1),
        stale_window=timedelta(seconds=CacheConfig.INFO_STALE_SECONDS),
        failure_cooldown=timedelta(seconds=CacheConfig.INFO_FAILURE_COOLDOWN_SECONDS),
    ),
    "financials": FamilyCachePolicy(
        fresh_window=timedelta(days=1),
        stale_window=timedelta(seconds=CacheConfig.INFO_STALE_SECONDS),
        failure_cooldown=timedelta(seconds=CacheConfig.INFO_FAILURE_COOLDOWN_SECONDS),
    ),
    "ratings": FamilyCachePolicy(
        fresh_window=timedelta(days=1),
        stale_window=timedelta(seconds=CacheConfig.INFO_STALE_SECONDS),
        failure_cooldown=timedelta(seconds=CacheConfig.INFO_FAILURE_COOLDOWN_SECONDS),
    ),
}

_FAMILY_CACHES: dict[StatsFamily, TieredCache[dict[str, Any]]] = {
    family: TieredCache(
        ttl_seconds=int(policy.fresh_window.total_seconds()),
        stale_seconds=int(policy.stale_window.total_seconds()),
        failure_cooldown_seconds=int(policy.failure_cooldown.total_seconds()),
    )
    for family, policy in FAMILY_POLICIES.items()
}
_PERSISTENCE_LOCK = RLock()
_REFRESH_EXECUTOR = ThreadPoolExecutor(max_workers=max(2, PortfolioConfig.MAX_WORKERS))
_RUNNING_REFRESHES: set[tuple[str, StatsFamily]] = set()
_RUNNING_REFRESHES_LOCK = Lock()


class ProviderBundle:
    """Lazy provider bundle reused across family refreshes for one ticker."""

    def __init__(self, ticker: str):
        self._ticker = ticker
        self._yahoo: YahooFinanceSource | None = None
        self._stockanalysis: StockAnalysisSource | None = None

    @property
    def yahoo(self) -> YahooFinanceSource:
        """Return the cached Yahoo provider."""
        if self._yahoo is None:
            self._yahoo = YahooFinanceSource(self._ticker)
        return self._yahoo

    @property
    def stockanalysis(self) -> StockAnalysisSource:
        """Return the cached StockAnalysis provider."""
        if self._stockanalysis is None:
            self._stockanalysis = StockAnalysisSource(self._ticker)
        return self._stockanalysis


def _parse_iso(value: Any) -> datetime | None:
    """Parse one ISO timestamp string into a UTC-aware datetime."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _family_timestamp(row: Mapping[str, Any], family: StatsFamily) -> datetime | None:
    """Return the best available timestamp for one family."""
    for field_name in family_timestamp_fields(family):
        if (parsed := _parse_iso(row.get(field_name))) is not None:
            return parsed
    return None


def _is_meaningful_family_value(value: Any) -> bool:
    """Return whether one cached family value should count as real payload."""
    if value is None:
        return False
    if isinstance(value, str):
        normalized = value.strip().upper()
        return bool(normalized and normalized != "NONE")
    if isinstance(value, Mapping):
        return bool(value)
    return True


def _has_meaningful_family_payload(row: Mapping[str, Any], family: StatsFamily) -> bool:
    """Return whether a family row contains any meaningful cached value."""
    return any(_is_meaningful_family_value(row.get(field)) for field in FAMILY_FIELDS[family] if field in row)


def _full_family_row(row: Mapping[str, Any], family: StatsFamily) -> dict[str, Any]:
    """Return the fields currently stored for one family."""
    return {field: row[field] for field in FAMILY_FIELDS[family] if field in row}


def _cached_snapshot(
    ticker: str,
    family: StatsFamily,
    persisted_row: Mapping[str, Any],
    now: datetime,
    *,
    allow_l1: bool,
) -> CachedFamilySnapshot:
    """Return the freshest available cached snapshot for one family."""
    l2_timestamp = _family_timestamp(persisted_row, family)
    l2_row = _full_family_row(persisted_row, family)
    chosen_tier: Literal["l1", "l2", "missing"] = "missing"
    chosen_timestamp: datetime | None = None
    chosen_row: dict[str, Any] = {}

    if l2_row and _has_meaningful_family_payload(l2_row, family):
        chosen_tier = "l2"
        chosen_timestamp = l2_timestamp
        chosen_row = dict(l2_row)

    if (
        allow_l1
        and (l1_entry := _FAMILY_CACHES[family].get_entry(ticker)) is not None
        and _has_meaningful_family_payload(l1_entry.value, family)
        and (chosen_timestamp is None or l1_entry.updated_at >= chosen_timestamp)
    ):
        chosen_tier = "l1"
        chosen_timestamp = l1_entry.updated_at
        chosen_row = dict(l1_entry.value)

    present = bool(chosen_row)
    if chosen_timestamp is None:
        return CachedFamilySnapshot(
            source_tier=chosen_tier,
            row=chosen_row,
            timestamp=None,
            is_fresh=False,
            is_stale=False,
            present=present,
        )

    policy = FAMILY_POLICIES[family]
    return CachedFamilySnapshot(
        source_tier=chosen_tier,
        row=chosen_row,
        timestamp=chosen_timestamp,
        is_fresh=chosen_timestamp >= now - policy.fresh_window,
        is_stale=chosen_timestamp >= now - policy.stale_window,
        present=present,
    )


def _persist_refresh_outcome(
    ticker: str,
    outcome: RefreshOutcome,
    *,
    existing_row: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Write through one refresh outcome into the persisted stats row."""
    ticker_symbol = normalize_ticker_symbol(ticker)
    if not ticker_symbol:
        return {}

    with _PERSISTENCE_LOCK:
        existing = existing_row if isinstance(existing_row, Mapping) else load_stats_row(ticker_symbol)
        merged = dict(existing) if isinstance(existing, dict) else {}

        for family, family_row in outcome.family_rows.items():
            for field in FAMILY_FIELDS[family]:
                if field in family_row:
                    merged[field] = family_row[field]
            merged[FAMILY_TIMESTAMP_FIELD[family]] = outcome.family_timestamps[family].isoformat()

        for field, value in outcome.extra_fields.items():
            merged[field] = value

        upsert_stats_row(ticker_symbol, merged)
        return dict(merged)


def _apply_family_row(
    base_row: Mapping[str, Any],
    family: StatsFamily,
    family_row: Mapping[str, Any],
    *,
    timestamp: datetime | None = None,
) -> dict[str, Any]:
    """Merge one family row into a broader stats row."""
    merged = dict(base_row)
    for field_name in FAMILY_FIELDS[family]:
        if field_name in family_row:
            merged[field_name] = family_row[field_name]
    if timestamp is not None:
        merged[FAMILY_TIMESTAMP_FIELD[family]] = timestamp.isoformat()
    return merged


def _flatten_outcome_extra_fields(outcome: RefreshOutcome, requested_family: StatsFamily) -> dict[str, Any]:
    """Flatten piggyback family results into plain fields for the current response."""
    extra_fields = dict(outcome.extra_fields)
    for family, family_row in outcome.family_rows.items():
        if family == requested_family:
            continue
        extra_fields.update(family_row)
    return extra_fields


def _fetch_market_data(bundle: ProviderBundle) -> RefreshOutcome:
    """Fetch the realtime market-data family from Yahoo."""
    fetched_at = datetime.now(tz=UTC)
    return RefreshOutcome(
        family_rows={"market_data": bundle.yahoo.get_market_data_snapshot()},
        family_timestamps={"market_data": fetched_at},
        extra_fields={},
    )


def _fetch_market_snapshot(bundle: ProviderBundle) -> RefreshOutcome:
    """Fetch the non-realtime market snapshot family from Yahoo."""
    fetched_at = datetime.now(tz=UTC)
    return RefreshOutcome(
        family_rows={"market_snapshot": bundle.yahoo.get_market_snapshot_fields()},
        family_timestamps={"market_snapshot": fetched_at},
        extra_fields={},
    )


def _statistics_forward_pe(stats: StockAnalysisStatistics, yahoo: YahooFinanceSource) -> float | None:
    """Return scraped forward PE first, then Yahoo only when needed."""
    if stats.pe_forward is not None:
        return stats.pe_forward
    if yahoo.get_quote_type() == ETF_QUOTE_TYPE:
        return None
    return yahoo.get_forward_pe_ntm()


def _statistics_family_row(stats: StockAnalysisStatistics, yahoo: YahooFinanceSource) -> dict[str, Any]:
    """Build the statistics family from StockAnalysis with Yahoo fallback."""
    return {
        "market_cap": stats.market_cap if stats.market_cap is not None else yahoo.get_market_cap(),
        "pe": stats.pe if stats.pe is not None else yahoo.get_pe_trailing(),
        "pe_forward": _statistics_forward_pe(stats, yahoo),
        "peg": stats.peg if stats.peg is not None else yahoo.get_peg(),
        "beta": stats.beta if stats.beta is not None else yahoo.get_beta(),
        "free_cash_flow": stats.free_cash_flow if stats.free_cash_flow is not None else yahoo.get_free_cash_flow_in_quote_currency(),
    }


def _statistics_extra_fields(stats: StockAnalysisStatistics) -> dict[str, Any]:
    """Return extra fields learned from the statistics page fetch."""
    extra_fields: dict[str, Any] = {}
    if stats.gross_margin is not None:
        extra_fields["gross_margin"] = to_percent(stats.gross_margin)
    if stats.debt_to_equity is not None:
        extra_fields["debt_to_equity"] = to_percent(stats.debt_to_equity)
    if stats.rsi is not None:
        extra_fields["rsi"] = stats.rsi
    return extra_fields


def _fetch_statistics(bundle: ProviderBundle) -> RefreshOutcome:
    """Fetch the statistics family with StockAnalysis-first rules."""
    stats = bundle.stockanalysis.get_statistics_snapshot()
    fetched_at = bundle.stockanalysis.statistics_fetched_at or datetime.now(tz=UTC)
    return RefreshOutcome(
        family_rows={"statistics": _statistics_family_row(stats, bundle.yahoo)},
        family_timestamps={"statistics": fetched_at},
        extra_fields=_statistics_extra_fields(stats),
    )


def _financials_family_row(
    financials: StockAnalysisFinancials,
    statistics: StockAnalysisStatistics,
    yahoo: YahooFinanceSource,
) -> dict[str, Any]:
    """Build the financials family from scraped pages with Yahoo fallback."""
    return {
        "revenue_growth": to_percent(financials.revenue_growth) if financials.revenue_growth is not None else yahoo.get_revenue_growth_percent(),
        "gross_margin": to_percent(financials.gross_margin)
        if financials.gross_margin is not None
        else (to_percent(statistics.gross_margin) if statistics.gross_margin is not None else yahoo.get_gross_margin_percent()),
        "debt_to_equity": to_percent(statistics.debt_to_equity) if statistics.debt_to_equity is not None else yahoo.get_debt_to_equity_percent(),
    }


def _fetch_financials(bundle: ProviderBundle) -> RefreshOutcome:
    """Fetch the financials family and reuse the statistics page when available."""
    financials = bundle.stockanalysis.get_financials_snapshot()
    statistics = bundle.stockanalysis.get_statistics_snapshot()
    yahoo = bundle.yahoo

    financials_row = _financials_family_row(financials, statistics, yahoo)
    financials_fetched_at = bundle.stockanalysis.financials_fetched_at or datetime.now(tz=UTC)
    statistics_fetched_at = bundle.stockanalysis.statistics_fetched_at or financials_fetched_at
    statistics_extra_fields = _statistics_extra_fields(statistics)
    statistics_extra_fields.pop("gross_margin", None)
    statistics_extra_fields.pop("debt_to_equity", None)

    return RefreshOutcome(
        family_rows={
            "financials": financials_row,
            "statistics": _statistics_family_row(statistics, yahoo),
        },
        family_timestamps={
            "financials": financials_fetched_at,
            "statistics": statistics_fetched_at,
        },
        extra_fields=statistics_extra_fields,
    )


def _fetch_ratings(bundle: ProviderBundle) -> RefreshOutcome:
    """Fetch the ratings family from Yahoo."""
    ratings_snapshot = bundle.yahoo.get_ratings_snapshot()
    fetched_at = datetime.now(tz=UTC)
    family_row = {
        "median_upside": ratings_snapshot.median_upside_pct if ratings_snapshot is not None else None,
        "ratings": ratings_snapshot.ratings if ratings_snapshot is not None else None,
    }
    return RefreshOutcome(
        family_rows={"ratings": family_row},
        family_timestamps={"ratings": fetched_at},
        extra_fields={},
    )


FAMILY_FETCHERS: dict[StatsFamily, Callable[[ProviderBundle], RefreshOutcome]] = {
    "market_data": _fetch_market_data,
    "market_snapshot": _fetch_market_snapshot,
    "statistics": _fetch_statistics,
    "financials": _fetch_financials,
    "ratings": _fetch_ratings,
}


def _refresh_family(bundle: ProviderBundle, family: StatsFamily) -> RefreshOutcome:
    """Refresh one family using the family-specific provider rules."""
    return FAMILY_FETCHERS[family](bundle)


def _log_family_decision(ticker: str, family: StatsFamily, mode: StatsResolutionMode, resolution: FamilyResolution) -> None:
    """Emit a structured log line for one family decision."""
    logger.info(
        "stats_resolver ticker=%s family=%s mode=%s decision=%s tier=%s queued_refresh=%s",
        ticker,
        family,
        mode,
        resolution.decision,
        resolution.source_tier,
        resolution.queued_refresh,
    )


def _queue_refresh(ticker: str, family: StatsFamily) -> bool:
    """Queue a background family refresh if one is not already running."""
    key = (ticker, family)
    with _RUNNING_REFRESHES_LOCK:
        if key in _RUNNING_REFRESHES:
            logger.info("stats_resolver ticker=%s family=%s decision=queued_refresh_deduped", ticker, family)
            return False
        _RUNNING_REFRESHES.add(key)

    def _run_background_refresh() -> None:
        started_at = datetime.now(tz=UTC)
        try:
            outcome = _refresh_family(ProviderBundle(ticker), family)
            for refreshed_family, family_row in outcome.family_rows.items():
                _FAMILY_CACHES[refreshed_family].set(
                    ticker,
                    family_row,
                    now=outcome.family_timestamps[refreshed_family],
                )
            _persist_refresh_outcome(ticker, outcome)
            elapsed_ms = round((datetime.now(tz=UTC) - started_at).total_seconds() * 1000, 1)
            logger.info(
                "stats_resolver ticker=%s family=%s decision=queued_refresh duration_ms=%s",
                ticker,
                family,
                elapsed_ms,
            )
        except Exception:
            _FAMILY_CACHES[family].mark_failure(ticker, now=started_at)
            logger.exception("stats_resolver ticker=%s family=%s decision=refresh_failed", ticker, family)
        finally:
            with _RUNNING_REFRESHES_LOCK:
                _RUNNING_REFRESHES.discard(key)

    _REFRESH_EXECUTOR.submit(_run_background_refresh)
    return True


def _resolve_family(
    bundle: ProviderBundle,
    ticker: str,
    family: StatsFamily,
    mode: StatsResolutionMode,
    persisted_row: Mapping[str, Any],
    now: datetime,
) -> FamilyResolution:
    """Resolve one family for one ticker."""
    if mode == "cache":
        cached_row = _full_family_row(persisted_row, family)
        resolution = FamilyResolution(
            family=family,
            row=cached_row,
            decision="fresh" if cached_row else "missing",
            source_tier="l2" if cached_row else "missing",
            timestamp=_family_timestamp(persisted_row, family),
        )
        _log_family_decision(ticker, family, mode, resolution)
        return resolution

    cached = _cached_snapshot(ticker, family, persisted_row, now, allow_l1=True)
    if mode != "live" and cached.is_fresh:
        resolution = FamilyResolution(
            family=family,
            row=cached.row,
            decision="fresh",
            source_tier=cached.source_tier,
            timestamp=cached.timestamp,
        )
        _log_family_decision(ticker, family, mode, resolution)
        return resolution

    if mode == "auto" and cached.is_stale and family not in BLOCKING_AUTO_FAMILIES:
        queued_refresh = False
        if _FAMILY_CACHES[family].should_retry(ticker, now=now):
            queued_refresh = _queue_refresh(ticker, family)
        resolution = FamilyResolution(
            family=family,
            row=cached.row,
            decision="stale_served",
            source_tier=cached.source_tier,
            timestamp=cached.timestamp,
            queued_refresh=queued_refresh,
        )
        _log_family_decision(ticker, family, mode, resolution)
        return resolution

    refresh_started_at = datetime.now(tz=UTC)
    try:
        outcome = _refresh_family(bundle, family)
        for refreshed_family, family_row in outcome.family_rows.items():
            _FAMILY_CACHES[refreshed_family].set(
                ticker,
                family_row,
                now=outcome.family_timestamps[refreshed_family],
            )
        _persist_refresh_outcome(ticker, outcome, existing_row=persisted_row)
        resolution = FamilyResolution(
            family=family,
            row=dict(outcome.family_rows.get(family) or {}),
            decision="inline_refresh",
            source_tier="live",
            timestamp=outcome.family_timestamps.get(family),
            extra_fields=_flatten_outcome_extra_fields(outcome, family),
            refresh_outcome=outcome,
        )
        elapsed_ms = round((datetime.now(tz=UTC) - refresh_started_at).total_seconds() * 1000, 1)
        logger.info(
            "stats_resolver ticker=%s family=%s decision=inline_refresh duration_ms=%s",
            ticker,
            family,
            elapsed_ms,
        )
        _log_family_decision(ticker, family, mode, resolution)
        return resolution
    except Exception:
        _FAMILY_CACHES[family].mark_failure(ticker, now=refresh_started_at)
        logger.exception("stats_resolver ticker=%s family=%s decision=refresh_failed", ticker, family)
        if mode == "live":
            raise
        if cached.is_stale and cached.present:
            resolution = FamilyResolution(
                family=family,
                row=cached.row,
                decision="stale_served",
                source_tier=cached.source_tier,
                timestamp=cached.timestamp,
            )
            _log_family_decision(ticker, family, mode, resolution)
            return resolution
        resolution = FamilyResolution(
            family=family,
            row={},
            decision="missing",
            source_tier="missing",
        )
        _log_family_decision(ticker, family, mode, resolution)
        return resolution


def _merge_refresh_outcome_into_row(base_row: Mapping[str, Any], outcome: RefreshOutcome) -> dict[str, Any]:
    """Apply a refresh outcome onto the resolved row."""
    merged = dict(base_row)
    for refreshed_family, family_row in outcome.family_rows.items():
        merged = _apply_family_row(
            merged,
            refreshed_family,
            family_row,
            timestamp=outcome.family_timestamps[refreshed_family],
        )
    merged.update(outcome.extra_fields)
    return merged


def _merge_family_resolution_into_row(
    base_row: Mapping[str, Any],
    family: StatsFamily,
    resolution: FamilyResolution,
) -> dict[str, Any]:
    """Apply one family resolution onto the resolved row."""
    if resolution.refresh_outcome is not None:
        return _merge_refresh_outcome_into_row(base_row, resolution.refresh_outcome)

    merged = dict(base_row)
    if resolution.row:
        merged = _apply_family_row(
            merged,
            family,
            resolution.row,
            timestamp=resolution.timestamp if resolution.source_tier == "live" else None,
        )
    if resolution.extra_fields:
        merged.update(resolution.extra_fields)
    return merged


def _classify_data_source(
    mode: StatsResolutionMode,
    families: Mapping[StatsFamily, FamilyResolution],
) -> Literal["cache", "live", "live_with_cache_fallback"]:
    """Classify the public data-source label from the family outcomes."""
    if mode == "cache":
        return "cache"
    if all(resolution.source_tier in {"live", "l1"} and not resolution.queued_refresh for resolution in families.values()):
        return "live"
    return "live_with_cache_fallback"


def resolve_ticker_stats(
    ticker: str,
    *,
    mode: StatsResolutionMode,
    persisted_row: Mapping[str, Any] | None = None,
) -> StatsResolutionResult:
    """Resolve one ticker row with family-level freshness and write-through caching."""
    ticker_symbol = normalize_ticker_symbol(ticker)
    if not ticker_symbol:
        return StatsResolutionResult(row={}, data_source="cache", families={})

    now = datetime.now(tz=UTC)
    base_row = dict(persisted_row) if isinstance(persisted_row, Mapping) else dict(load_stats_map().get(ticker_symbol) or {})
    bundle = ProviderBundle(ticker_symbol)

    families: dict[StatsFamily, FamilyResolution] = {}
    resolved_row = dict(base_row)
    for family in STAT_FAMILIES:
        resolution = _resolve_family(bundle, ticker_symbol, family, mode, resolved_row, now)
        families[family] = resolution
        resolved_row = _merge_family_resolution_into_row(resolved_row, family, resolution)

    return StatsResolutionResult(
        row=resolved_row,
        data_source=_classify_data_source(mode, families),
        families=families,
    )


async def resolve_ticker_stats_async(
    ticker: str,
    *,
    mode: StatsResolutionMode,
    persisted_row: Mapping[str, Any] | None = None,
) -> StatsResolutionResult:
    """Async wrapper for resolving one ticker row."""
    return await asyncio.to_thread(
        resolve_ticker_stats,
        ticker,
        mode=mode,
        persisted_row=persisted_row,
    )


def _normalize_tickers(tickers: Sequence[str]) -> list[str]:
    """Normalize ticker inputs and preserve unique order."""
    normalized = [ticker_symbol for ticker in tickers if (ticker_symbol := normalize_ticker_symbol(ticker))]
    return list(dict.fromkeys(normalized))


def resolve_ticker_stats_map(
    tickers: Sequence[str],
    *,
    mode: StatsResolutionMode,
    persisted_rows: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, StatsResolutionResult]:
    """Resolve multiple ticker rows in parallel."""
    ordered_unique = _normalize_tickers(tickers)
    if not ordered_unique:
        return {}

    def _resolve_one(ticker_symbol: str) -> tuple[str, StatsResolutionResult]:
        row = dict((persisted_rows or {}).get(ticker_symbol) or {})
        return ticker_symbol, resolve_ticker_stats(ticker_symbol, mode=mode, persisted_row=row)

    with ThreadPoolExecutor(max_workers=PortfolioConfig.MAX_WORKERS) as executor:
        results = list(executor.map(_resolve_one, ordered_unique))
    return dict(results)


async def resolve_ticker_stats_map_async(
    tickers: Sequence[str],
    *,
    mode: StatsResolutionMode,
    persisted_rows: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, StatsResolutionResult]:
    """Resolve multiple ticker rows asynchronously."""
    ordered_unique = _normalize_tickers(tickers)
    if not ordered_unique:
        return {}

    semaphore = asyncio.Semaphore(max(1, PortfolioConfig.MAX_WORKERS))

    async def _resolve_one(ticker_symbol: str) -> tuple[str, StatsResolutionResult]:
        async with semaphore:
            row = dict((persisted_rows or {}).get(ticker_symbol) or {})
            result = await resolve_ticker_stats_async(
                ticker_symbol,
                mode=mode,
                persisted_row=row,
            )
            return ticker_symbol, result

    results = await asyncio.gather(*(_resolve_one(ticker_symbol) for ticker_symbol in ordered_unique))
    return dict(results)


def aggregate_data_source(
    results: Mapping[str, StatsResolutionResult],
    *,
    mode: StatsResolutionMode,
) -> Literal["cache", "live", "live_with_cache_fallback"]:
    """Aggregate per-ticker results into one public data-source label."""
    if mode == "cache":
        return "cache"
    if not results:
        return "cache"
    if all(result.data_source == "live" for result in results.values()):
        return "live"
    return "live_with_cache_fallback"
