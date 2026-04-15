"""Resolve ETF holdings and sector snapshots with cache support."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta
import re
from typing import Any

from stock_search.common_utils import normalize_ticker_symbol
from stock_search.data_sources.stockanalysis import StockAnalysisSource
from stock_search.data_sources.yahoofinance import ETF_QUOTE_TYPE, YahooFinanceSource
from stock_search.models import SECTOR_LABELS, SECTOR_PATTERN_RULES, ETFSector, Holding

ETF_CACHE_MAX_AGE_DAYS = 7

SECTOR_REGEX_MAP: tuple[tuple[re.Pattern[str], str], ...] = tuple((re.compile(pattern, flags=re.IGNORECASE), label) for pattern, label in SECTOR_PATTERN_RULES)


@dataclass(frozen=True)
class ETFSnapshotResult:
    """Represent one resolved ETF snapshot result."""

    holdings: list[Holding]
    sectors: list[ETFSector]
    error: str | None


@dataclass(frozen=True)
class ETFResolutionResult:
    """Represent ETF resolution results for one portfolio pass."""

    stock_positions: list[dict[str, Any]]
    etf_positions: list[dict[str, Any]]
    snapshot_by_ticker: dict[str, ETFSnapshotResult]
    etf_refreshed_count: int
    cache_changed: bool


def _pool_workers(item_count: int, cap: int | None = None) -> int:
    """Return the thread-pool size used for ETF fetches."""
    if item_count <= 0:
        return 1
    if cap is None:
        return item_count
    return max(1, min(item_count, cap))


def _is_cache_entry_fresh(fetched_at: str, *, now: datetime) -> bool:
    """Return whether an ETF cache entry is still fresh."""
    try:
        fetched_at_dt = datetime.fromisoformat(fetched_at)
    except ValueError:
        return False
    return now - fetched_at_dt <= timedelta(days=ETF_CACHE_MAX_AGE_DAYS)


def normalize_sector_name(raw: str | None) -> str:
    """Normalize sector labels into a stable display form."""
    sector_text = (raw or "").strip()
    if not sector_text:
        return SECTOR_LABELS["other"]
    for pattern, canonical_label in SECTOR_REGEX_MAP:
        if pattern.search(sector_text):
            return canonical_label
    return SECTOR_LABELS["other"]


def _parse_cached_snapshot(
    stats_data: dict[str, Any],
    *,
    ticker: str,
    now: datetime,
    require_fresh: bool,
) -> tuple[list[Holding], list[ETFSector]] | None:
    """Parse cached snapshot."""
    entry = stats_data.get(ticker, {})
    if not isinstance(entry, dict):
        return None

    fetched_at = entry.get("etf_holdings_fetched_at")
    holdings_raw = entry.get("etf_holdings")
    sectors_raw = entry.get("etf_sectors")
    if not isinstance(fetched_at, str) or not isinstance(holdings_raw, list):
        return None
    if require_fresh and not _is_cache_entry_fresh(fetched_at, now=now):
        return None

    try:
        holdings = [Holding.model_validate(holding) for holding in holdings_raw]
    except Exception:
        return None

    sectors: list[ETFSector] = []
    if isinstance(sectors_raw, list):
        for sector in sectors_raw:
            if not isinstance(sector, dict):
                continue
            name = normalize_sector_name(str(sector.get("name") or "").strip())
            weight_raw = sector.get("weight")
            if not isinstance(weight_raw, (int, float)):
                continue
            sectors.append(ETFSector(name=name, weight=float(weight_raw)))

    return holdings, sectors


def load_etf_cache_from_stats(stats_data: dict[str, Any], ticker: str, now: datetime) -> tuple[list[Holding], list[ETFSector]] | None:
    """Load ETF cache from stats."""
    return _parse_cached_snapshot(
        stats_data,
        ticker=normalize_ticker_symbol(ticker),
        now=now,
        require_fresh=True,
    )


def _load_stale_cache_from_stats(
    stats_data: dict[str, Any],
    ticker: str,
    now: datetime,
) -> tuple[list[Holding], list[ETFSector]] | None:
    """Load stale ETF cache entries from the stats store."""
    return _parse_cached_snapshot(
        stats_data,
        ticker=normalize_ticker_symbol(ticker),
        now=now,
        require_fresh=False,
    )


def _sector_rows(snapshot_sectors: object) -> list[ETFSector]:
    """Convert sector weights into normalized table rows."""
    if not hasattr(snapshot_sectors, "model_dump"):
        return []
    rows: list[ETFSector] = []
    for key, value in snapshot_sectors.model_dump().items():
        if value is None:
            continue
        sector_name = SECTOR_LABELS.get(str(key), str(key).replace("_", " ").title())
        rows.append(ETFSector(name=normalize_sector_name(sector_name), weight=float(value)))
    rows.sort(key=lambda row: row.weight, reverse=True)
    return rows


def _serialized_cache_payload(*, holdings: list[Holding], sectors: list[ETFSector], fetched_at: str) -> dict[str, Any]:
    """Serialize an ETF snapshot for cache storage."""
    return {
        "etf_holdings": [holding.model_dump() for holding in holdings],
        "etf_sectors": [sector.model_dump() for sector in sectors],
        "etf_holdings_fetched_at": fetched_at,
    }


def store_etf_cache_in_stats(
    stats_data: dict[str, Any],
    ticker: str,
    holdings: list[Holding],
    sectors: list[ETFSector],
    now: datetime,
) -> bool:
    """Store ETF cache in stats."""
    ticker_key = normalize_ticker_symbol(ticker)
    entry = stats_data.get(ticker_key, {})
    if not isinstance(entry, dict):
        entry = {}

    payload = _serialized_cache_payload(holdings=holdings, sectors=sectors, fetched_at=now.isoformat())
    changed = (
        entry.get("etf_holdings") != payload["etf_holdings"]
        or entry.get("etf_sectors") != payload["etf_sectors"]
        or entry.get("etf_holdings_fetched_at") != payload["etf_holdings_fetched_at"]
    )
    if changed:
        entry.update(payload)
        stats_data[ticker_key] = entry
    return changed


def is_etf_ticker(ticker: str) -> bool:
    """Return whether ETF ticker."""
    try:
        quote_type = YahooFinanceSource(ticker).get_quote_type()
    except Exception:
        return False
    return quote_type == ETF_QUOTE_TYPE


def get_etf_snapshot(ticker: str) -> tuple[list[Holding], list[ETFSector], str | None]:
    """Fetch one ETF snapshot from the available data sources."""
    try:
        snapshot = StockAnalysisSource(ticker).get_etf_holdings_snapshot()
    except Exception as exc:
        return [], [], str(exc)
    if snapshot is None:
        return [], [], "no snapshot returned"
    return snapshot.holdings.holdings, _sector_rows(snapshot.sectors), None


def _fetch_quote_type(ticker: str) -> tuple[str, bool]:
    """Fetch quote type."""
    return ticker, is_etf_ticker(ticker)


def _fetch_snapshot(ticker: str) -> tuple[str, list[Holding], list[ETFSector], str | None]:
    """Fetch snapshot."""
    holdings, sectors, error = get_etf_snapshot(ticker)
    return ticker, holdings, sectors, error


def _is_etf_from_stats(stats_data: dict[str, Any], ticker: str) -> bool | None:
    """Return whether ETF from stats."""
    entry = stats_data.get(ticker)
    if not isinstance(entry, dict):
        return None
    quote_type = str(entry.get("quote_type") or "").upper().strip()
    if not quote_type:
        return None
    return quote_type == ETF_QUOTE_TYPE


def classify_and_resolve_etfs(
    positions: list[dict[str, Any]],
    stats_data: dict[str, Any],
    now: datetime,
) -> ETFResolutionResult:
    """Split portfolio tickers into ETF and non-ETF groups and resolve snapshots."""
    stock_positions: list[dict[str, Any]] = []
    etf_positions: list[dict[str, Any]] = []
    snapshot_by_ticker: dict[str, ETFSnapshotResult] = {}
    unresolved_tickers: list[str] = []
    position_by_ticker = {normalize_ticker_symbol(position["ticker"]): position for position in positions}

    for position in positions:
        ticker = normalize_ticker_symbol(position["ticker"])
        cached_snapshot = load_etf_cache_from_stats(stats_data, ticker, now)
        if cached_snapshot is not None and cached_snapshot[1]:
            holdings, sectors = cached_snapshot
            etf_positions.append(position)
            snapshot_by_ticker[ticker] = ETFSnapshotResult(holdings=holdings, sectors=sectors, error=None)
            continue

        is_etf_from_stats = _is_etf_from_stats(stats_data, ticker)
        if is_etf_from_stats is True:
            etf_positions.append(position)
            continue
        if is_etf_from_stats is False:
            stock_positions.append(position)
            continue
        unresolved_tickers.append(ticker)

    if unresolved_tickers:
        with ThreadPoolExecutor(max_workers=_pool_workers(len(unresolved_tickers), cap=32)) as executor:
            classified = list(executor.map(_fetch_quote_type, unresolved_tickers))
        for ticker, is_etf in classified:
            pos = position_by_ticker[ticker]
            if is_etf:
                etf_positions.append(pos)
            else:
                stock_positions.append(pos)

    etf_tickers = {normalize_ticker_symbol(position["ticker"]) for position in etf_positions}
    for position in positions:
        ticker = normalize_ticker_symbol(position["ticker"])
        if ticker not in etf_tickers and position not in stock_positions:
            stock_positions.append(position)

    missing_tickers = [normalize_ticker_symbol(position["ticker"]) for position in etf_positions if normalize_ticker_symbol(position["ticker"]) not in snapshot_by_ticker]
    etf_refreshed_count = 0
    cache_changed = False
    if missing_tickers:
        with ThreadPoolExecutor(max_workers=_pool_workers(len(missing_tickers), cap=16)) as executor:
            fetched = list(executor.map(_fetch_snapshot, missing_tickers))
        for ticker, holdings, sectors, error in fetched:
            if error is None:
                etf_refreshed_count += 1
                cache_changed = store_etf_cache_in_stats(stats_data, ticker, holdings, sectors, now) or cache_changed
                snapshot_by_ticker[ticker] = ETFSnapshotResult(holdings=holdings, sectors=sectors, error=None)
                continue

            stale_snapshot = _load_stale_cache_from_stats(stats_data, ticker, now)
            if stale_snapshot is not None:
                stale_holdings, stale_sectors = stale_snapshot
                snapshot_by_ticker[ticker] = ETFSnapshotResult(
                    holdings=stale_holdings,
                    sectors=stale_sectors,
                    error=error,
                )
            else:
                snapshot_by_ticker[ticker] = ETFSnapshotResult(holdings=[], sectors=[], error=error)

    return ETFResolutionResult(
        stock_positions=stock_positions,
        etf_positions=etf_positions,
        snapshot_by_ticker=snapshot_by_ticker,
        etf_refreshed_count=etf_refreshed_count,
        cache_changed=cache_changed,
    )
