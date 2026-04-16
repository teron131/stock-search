"""Build portfolio dashboard payloads from live and cached data."""

import asyncio
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pandas as pd
from rich import box
from rich.console import Console
from rich.table import Table

from stock_search.api.data_store import (
    load_positions as load_positions_store,
    load_stats_map,
    load_stock_families,
    upsert_stats_rows,
)
from stock_search.cache import TieredCache
from stock_search.common_utils import clamp, normalize_ticker_symbol, safe_float
from stock_search.config import PortfolioConfig, UpdateTierLabels
from stock_search.data_sources.yahoofinance import YahooFinanceSource
from stock_search.etf import ETFResolutionResult, classify_and_resolve_etfs, normalize_sector_name
from stock_search.evaluation.constants import (
    DEFAULT_BEAR_PROBABILITY,
    DEFAULT_BULL_PROBABILITY,
    DEFAULT_SCORE,
    CalibrationConfig,
)
from stock_search.evaluation.normalization import bucket_from_eval_json, normalize_eval_json
from stock_search.labeler import aget_labels, get_labels
from stock_search.models.field_definitions import EVAL_FIELD_DEFINITIONS, MARKET_FIELDS
from stock_search.stats_resolver import (
    StatsResolutionMode,
    StatsResolutionResult,
    aggregate_data_source,
    resolve_ticker_stats,
    resolve_ticker_stats_async,
    resolve_ticker_stats_map,
    resolve_ticker_stats_map_async,
)

_PORTFOLIO_LABEL_FIELD = "industry_labels"
_LABEL_FETCHED_AT_FIELD = "industry_labels_fetched_at"
_LABEL_CACHE_MAX_AGE_DAYS = 30
_SECTOR_CACHE = TieredCache[str](
    ttl_seconds=30 * 24 * 60 * 60,
    stale_seconds=365 * 24 * 60 * 60,
    failure_cooldown_seconds=60 * 60,
)


@dataclass
class PortfolioPayloadInputs:
    """Cache-backed inputs needed to assemble one portfolio payload."""

    stats_data: dict[str, Any]
    eval_data: dict[str, Any]
    positions: list[dict[str, Any]]
    held_positions: list[dict[str, Any]]
    held_tickers: list[str]


def normalize_labels(value: Any) -> list[str]:
    """Normalize stored label values into a unique string list."""
    if not isinstance(value, list):
        return []
    labels: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        label = item.strip()
        if not label or label in seen:
            continue
        seen.add(label)
        labels.append(label)
    return labels


def _parse_iso_timestamp(value: Any) -> datetime | None:
    """Parse an ISO timestamp string into a datetime."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _load_label_cache(
    path: Path | None = None,
    *,
    stats_data: Mapping[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    """Load cached portfolio labels from the stats store."""
    _ = path
    stats_map = stats_data if isinstance(stats_data, Mapping) else load_stats_map()
    cache: dict[str, dict[str, Any]] = {}
    for ticker, row in stats_map.items():
        if not isinstance(row, dict):
            continue
        ticker_symbol = normalize_ticker_symbol(str(ticker))
        if not ticker_symbol:
            continue
        normalized = normalize_labels(row.get(_PORTFOLIO_LABEL_FIELD) or row.get("labels"))
        if normalized:
            cache[ticker_symbol] = {
                "labels": normalized,
                "fetched_at": _parse_iso_timestamp(row.get(_LABEL_FETCHED_AT_FIELD)),
            }
    return cache


def _save_label_cache_rows(
    cache: dict[str, dict[str, Any]],
    *,
    updated_tickers: list[str],
    stats_data: dict[str, Any],
) -> None:
    """Persist refreshed label cache entries for only the changed tickers."""
    changed_rows: dict[str, dict[str, Any]] = {}
    for ticker in updated_tickers:
        ticker_symbol = normalize_ticker_symbol(ticker)
        if not ticker_symbol:
            continue
        entry = cache.get(ticker_symbol)
        if not isinstance(entry, dict):
            continue
        labels = normalize_labels(entry.get("labels"))
        if not labels:
            continue
        fetched_at = entry.get("fetched_at")
        existing = stats_data.get(ticker_symbol, {})
        row = dict(existing) if isinstance(existing, dict) else {}
        row[_PORTFOLIO_LABEL_FIELD] = labels
        row[_LABEL_FETCHED_AT_FIELD] = fetched_at.isoformat() if isinstance(fetched_at, datetime) else datetime.now(tz=UTC).isoformat()
        stats_data[ticker_symbol] = row
        changed_rows[ticker_symbol] = row

    upsert_stats_rows(changed_rows, update_generated_at=True)


def _portfolio_tickers(positions: list[dict[str, Any]]) -> list[str]:
    """Return the unique ticker list from the portfolio positions."""
    tickers: list[str] = []
    for row in positions:
        ticker = normalize_ticker_symbol(str(row.get("ticker", "")))
        if ticker:
            tickers.append(ticker)
    return list(dict.fromkeys(tickers))


def _compute_missing_labels(
    tickers: list[str],
    cache: dict[str, dict[str, Any]],
) -> list[str]:
    """Return the tickers whose cached labels are missing or stale."""
    cutoff = datetime.now(tz=UTC) - timedelta(days=_LABEL_CACHE_MAX_AGE_DAYS)
    missing: list[str] = []
    for ticker in tickers:
        entry = cache.get(ticker)
        if not entry:
            missing.append(ticker)
            continue
        fetched_at = entry.get("fetched_at")
        if not isinstance(fetched_at, datetime) or fetched_at < cutoff:
            missing.append(ticker)
    return missing


def resolve_portfolio_labels(
    positions: list[dict[str, Any]],
    *,
    fetch_missing: bool = True,
    max_concurrency: int = 4,
    cache_path: Path | None = None,
    stats_data: Mapping[str, Any] | None = None,
) -> dict[str, list[str]]:
    """Resolve portfolio labels with cache reuse and optional fetching."""
    tickers = _portfolio_tickers(positions)
    if not tickers:
        return {}

    cache = _load_label_cache(cache_path, stats_data=stats_data)
    missing = _compute_missing_labels(tickers, cache)
    fetched: dict[str, list[str]] = {}
    if fetch_missing and missing:
        batch = get_labels(missing, max_concurrency=max_concurrency)
        for ticker, result in batch.items():
            normalized = normalize_labels(result.labels if result is not None else [])
            if normalized:
                fetched[ticker] = normalized

    changed = False
    for ticker, labels in fetched.items():
        existing = cache.get(ticker, {})
        if existing.get("labels") != labels or existing.get("fetched_at") is None:
            changed = True
        cache[ticker] = {"labels": labels, "fetched_at": datetime.now(tz=UTC)}
    if changed:
        current_stats = dict(stats_data) if isinstance(stats_data, dict) else load_stats_map()
        _save_label_cache_rows(
            cache,
            updated_tickers=list(fetched),
            stats_data=current_stats,
        )

    return {ticker: normalize_labels(cache.get(ticker, {}).get("labels")) for ticker in tickers}


async def resolve_portfolio_labels_async(
    positions: list[dict[str, Any]],
    *,
    fetch_missing: bool = True,
    max_concurrency: int = 4,
    cache_path: Path | None = None,
    stats_data: Mapping[str, Any] | None = None,
) -> dict[str, list[str]]:
    """Resolve portfolio labels asynchronously with cache reuse."""
    tickers = _portfolio_tickers(positions)
    if not tickers:
        return {}

    cache = _load_label_cache(cache_path, stats_data=stats_data)
    missing = _compute_missing_labels(tickers, cache)
    fetched: dict[str, list[str]] = {}
    if fetch_missing and missing:
        batch = await aget_labels(missing, max_concurrency=max_concurrency)
        for ticker, result in batch.items():
            normalized = normalize_labels(result.labels if result is not None else [])
            if normalized:
                fetched[ticker] = normalized

    changed = False
    for ticker, labels in fetched.items():
        existing = cache.get(ticker, {})
        if existing.get("labels") != labels or existing.get("fetched_at") is None:
            changed = True
        cache[ticker] = {"labels": labels, "fetched_at": datetime.now(tz=UTC)}
    if changed:
        current_stats = dict(stats_data) if isinstance(stats_data, dict) else load_stats_map()
        _save_label_cache_rows(
            cache,
            updated_tickers=list(fetched),
            stats_data=current_stats,
        )

    return {ticker: normalize_labels(cache.get(ticker, {}).get("labels")) for ticker in tickers}


def calculate_total(quantity: float, price: float) -> float:
    """
    Calculate total position value from held quantity.

    Args:
        quantity: Number of underlying shares held
        price: Current price in USD

    Returns:
        Total position value in USD
    """
    return quantity * price


def calculate_position_weight(total: float, total_equity: float) -> float:
    """
    Calculate position weight as % of equity.

    Args:
        total: Total position value
        total_equity: Total equity

    Returns:
        Weight as percentage
    """
    if total_equity <= 0:
        return 0.0
    return (total / total_equity) * 100


def _map_linear(
    value: float | None,
    *,
    in_min: float,
    in_max: float,
    out_min: float,
    out_max: float,
) -> float | None:
    """Map a value linearly from one numeric range into another."""
    if value is None or in_max == in_min:
        return None
    ratio = (value - in_min) / (in_max - in_min)
    return out_min + ratio * (out_max - out_min)


def _indicator_eval_fallback(stats: dict[str, Any]) -> dict[str, float]:
    """Deterministic score fallback when LLM evaluation is missing/partial."""
    pe_forward = stats.get("pe_forward")
    pe = stats.get("pe")
    revenue_growth = stats.get("revenue_growth")
    gross_margin = stats.get("gross_margin")
    median_upside = stats.get("median_upside")
    pe_fwd_min, _, pe_fwd_max = CalibrationConfig.FORWARD_PE_RANGE
    pe_min, _, pe_max = CalibrationConfig.TRAILING_PE_RANGE
    rev_g_min, _, rev_g_max = CalibrationConfig.REVENUE_GROWTH_PCT_RANGE
    margin_min, _, margin_max = CalibrationConfig.GROSS_MARGIN_PCT_RANGE
    upside_min, _, upside_max = CalibrationConfig.UPSIDE_RANGE

    valuation_parts = [
        _map_linear(pe_forward, in_min=pe_fwd_min, in_max=pe_fwd_max, out_min=10.0, out_max=2.0),
        _map_linear(pe, in_min=pe_min, in_max=pe_max, out_min=10.0, out_max=2.0),
    ]
    valuation_values = [v for v in valuation_parts if v is not None]
    valuation = clamp(sum(valuation_values) / len(valuation_values), 0.0, 10.0) if valuation_values else DEFAULT_SCORE

    quality_parts = [
        _map_linear(revenue_growth, in_min=rev_g_min, in_max=rev_g_max, out_min=2.0, out_max=10.0),
        _map_linear(gross_margin, in_min=margin_min, in_max=margin_max, out_min=2.0, out_max=10.0),
    ]
    quality_values = [v for v in quality_parts if v is not None]
    quality = clamp(sum(quality_values) / len(quality_values), 0.0, 10.0) if quality_values else DEFAULT_SCORE

    upside_val = _map_linear(median_upside, in_min=upside_min, in_max=upside_max, out_min=2.0, out_max=10.0)
    upside = clamp(upside_val, 0.0, 10.0) if upside_val is not None else DEFAULT_SCORE

    moat = DEFAULT_SCORE
    overall = clamp((moat + quality + valuation + upside) / 4, 0.0, 10.0)

    momentum_fields = (
        "change_percent_1d",
        "change_percent_1m",
        "change_percent_3m",
        "change_percent_6m",
        "change_percent_1y",
    )
    momentum_values = [float(stats[name]) for name in momentum_fields if isinstance(stats.get(name), (int, float))]
    if momentum_values:
        avg_momentum = sum(momentum_values) / len(momentum_values)
        bull = max(0.0, min(1.0, 0.5 + (avg_momentum / 100.0)))
        bear = max(0.0, min(1.0, 0.2 - (avg_momentum / 200.0)))
    else:
        bull = DEFAULT_BULL_PROBABILITY
        bear = DEFAULT_BEAR_PROBABILITY

    return {
        "overall_score": round(overall, 2),
        "quality_score": round(quality, 2),
        "valuation_score": round(valuation, 2),
        "moat_score": round(moat, 2),
        "upside_score": round(upside, 2),
        "bull_probability": round(bull, 4),
        "bear_probability": round(bear, 4),
    }


def _pick_eval_value(
    *,
    eval_data: dict[str, Any],
    normalized_eval: dict[str, Any],
    fallback_eval: dict[str, float],
    key: str,
    aliases: tuple[str, ...] = (),
) -> tuple[float, bool]:
    """Pick the first usable evaluation field from a row."""
    has_llm_value = any(alias in eval_data and eval_data.get(alias) is not None for alias in (key, *aliases))
    if has_llm_value and key in normalized_eval:
        return float(normalized_eval[key]), True
    return float(fallback_eval[key]), False


def fetch_live_stats(
    ticker: str,
    *,
    mode: StatsResolutionMode = "auto",
    persisted_row: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Ticker-level stats entrypoint backed by the shared family resolver."""
    result = resolve_ticker_stats(
        ticker,
        mode=mode,
        persisted_row=persisted_row,
    )
    return dict(result.row)


async def fetch_live_stats_async(
    ticker: str,
    *,
    mode: StatsResolutionMode = "auto",
    persisted_row: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Async-ready ticker-level stats entrypoint backed by the shared resolver."""
    result = await resolve_ticker_stats_async(
        ticker,
        mode=mode,
        persisted_row=persisted_row,
    )
    return dict(result.row)


def _ticker_key(ticker: str) -> str:
    """Return the normalized lookup key for a ticker symbol."""
    return str(ticker).upper().strip()


def fetch_live_stats_map(
    tickers: Sequence[str],
    *,
    mode: StatsResolutionMode = "auto",
    persisted_rows: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    """Batch ticker-level stats fetch backed by the shared family resolver."""
    results = resolve_ticker_stats_map(
        tickers,
        mode=mode,
        persisted_rows=persisted_rows,
    )
    return {ticker: dict(result.row) for ticker, result in results.items()}


async def fetch_live_stats_map_async(
    tickers: Sequence[str],
    *,
    mode: StatsResolutionMode = "auto",
    persisted_rows: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    """Async batch ticker-level stats fetch backed by the shared resolver."""
    results = await resolve_ticker_stats_map_async(
        tickers,
        mode=mode,
        persisted_rows=persisted_rows,
    )
    return {ticker: dict(result.row) for ticker, result in results.items()}


def _derive_bucket_from_eval(ticker: str, eval_data: dict[str, Any]) -> str | None:
    """Derive a display bucket from the normalized evaluation payload."""
    return bucket_from_eval_json(ticker, eval_data)


def _build_row(
    pos: dict[str, Any],
    stats_cache: dict[str, Any],
    eval_cache: dict[str, Any],
    live_market: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build one dashboard row from the resolved ticker data."""
    ticker = pos.get("ticker")
    if not ticker:
        return {}
    qty = float(pos.get("quantity") or 0)

    cached = stats_cache.get(ticker, {})
    if not isinstance(cached, dict):
        cached = {}

    cached_meta: dict[str, Any] = {k: v for k, v in cached.items() if k not in MARKET_FIELDS}
    cached_market: dict[str, Any] = {k: v for k, v in cached.items() if k in MARKET_FIELDS}

    eval_data = eval_cache.get(ticker, {})
    if not isinstance(eval_data, dict):
        eval_data = {}

    resolved_live_market = live_market if isinstance(live_market, dict) else {}

    stats: dict[str, Any] = {**cached_meta, **cached_market, **resolved_live_market}

    price = stats.get("price")

    total = calculate_total(qty, price) if qty and price else 0.0

    normalized_eval = normalize_eval_json(eval_data)
    fallback_eval = _indicator_eval_fallback(stats)

    selected_eval: dict[str, float] = {}
    llm_count = 0
    for field in EVAL_FIELD_DEFINITIONS:
        value, is_from_llm = _pick_eval_value(
            eval_data=eval_data,
            normalized_eval=normalized_eval,
            fallback_eval=fallback_eval,
            key=field.key,
            aliases=field.aliases,
        )
        selected_eval[field.key] = value
        if is_from_llm:
            llm_count += 1

    total_eval_fields = len(EVAL_FIELD_DEFINITIONS)
    eval_source = "llm" if llm_count == total_eval_fields else ("indicator_fallback" if llm_count == 0 else "hybrid")

    strategy = pos.get("strategy") or _derive_bucket_from_eval(ticker, eval_data) or stats.get("strategy")
    industry_labels = normalize_labels(pos.get("industry_labels"))
    primary_label = industry_labels[0] if industry_labels else None
    quote_type = str(stats.get("quote_type") or "").upper()
    equity_type = "ETF" if quote_type == "ETF" else ("STOCK" if quote_type else "UNKNOWN")
    etf_holdings = stats.get("etf_holdings") or stats.get("holdings") or []
    if not isinstance(etf_holdings, list):
        etf_holdings = []
    etf_holdings_fetched_at = stats.get("etf_holdings_fetched_at")
    if etf_holdings_fetched_at is not None:
        etf_holdings_fetched_at = str(etf_holdings_fetched_at)
    etf_holdings_update_tier = UpdateTierLabels.ETF_HOLDINGS_LABEL if etf_holdings else None

    return {
        "overall_score": selected_eval["overall_score"],
        "quality_score": selected_eval["quality_score"],
        "valuation_score": selected_eval["valuation_score"],
        "moat_score": selected_eval["moat_score"],
        "upside_score": selected_eval["upside_score"],
        "market_cap_score": normalized_eval.get("market_cap_score"),
        "bull_probability": selected_eval["bull_probability"],
        "bear_probability": selected_eval["bear_probability"],
        "eval_source": eval_source,
        "market_update_tier": UpdateTierLabels.FAST_LABEL,
        "indicator_update_tier": UpdateTierLabels.SLOW_LABEL,
        "ratings_update_tier": UpdateTierLabels.RATINGS_LABEL,
        "evaluation_update_tier": UpdateTierLabels.EVAL_LABEL,
        "etf_holdings_update_tier": etf_holdings_update_tier,
        "rank": None,
        "ticker": ticker,
        "name": stats.get("name"),
        "equity_type": equity_type,
        "quantity": qty,
        "price": price,
        "change": stats.get("change"),
        "change_percent_1d": stats.get("change_percent_1d"),
        "market_cap": stats.get("market_cap"),
        "pe": stats.get("pe"),
        "pe_forward": stats.get("pe_forward"),
        "peg": stats.get("peg"),
        "beta": stats.get("beta"),
        "iv": stats.get("iv"),
        "debt_to_equity": stats.get("debt_to_equity"),
        "free_cash_flow": stats.get("free_cash_flow"),
        "revenue_growth": stats.get("revenue_growth"),
        "gross_margin": stats.get("gross_margin"),
        "rsi": stats.get("rsi"),
        "change_percent_1m": stats.get("change_percent_1m"),
        "change_percent_3m": stats.get("change_percent_3m"),
        "change_percent_6m": stats.get("change_percent_6m"),
        "change_percent_1y": stats.get("change_percent_1y"),
        "median_upside": stats.get("median_upside"),
        "etf_holdings": etf_holdings,
        "etf_holdings_fetched_at": etf_holdings_fetched_at,
        "strategy": strategy,
        "industry_labels": industry_labels,
        "primary_label": primary_label,
        "total": total,
        "weight_pct": None,
    }


def _compute_weights(total_by_ticker: dict[str, float], portfolio_total: float) -> dict[str, float]:
    """Compute position weights from per-row notional values."""
    if portfolio_total <= 0:
        return dict.fromkeys(total_by_ticker, 0.0)
    return {ticker: (total / portfolio_total) * 100.0 for ticker, total in total_by_ticker.items()}


def _weighted_average(rows: list[dict[str, Any]], field_name: str) -> float | None:
    """Compute a weighted average while skipping missing values."""
    weighted_sum = 0.0
    total_weight = 0.0

    for row in rows:
        total = safe_float(row.get("total"))
        value = safe_float(row.get(field_name))
        if total is None or total <= 0 or value is None:
            continue
        weighted_sum += value * total
        total_weight += total

    if total_weight <= 0:
        return None
    return weighted_sum / total_weight


def _build_portfolio_stats(rows: list[dict[str, Any]], sector_table: list[dict[str, Any]]) -> dict[str, Any]:
    """Build the aggregate statistics block for the portfolio."""
    held_rows = [row for row in rows if safe_float(row.get("quantity")) not in (None, 0.0)]

    total = sum(float(safe_float(row.get("total")) or 0.0) for row in held_rows)
    change_value = 0.0
    for row in held_rows:
        change_percent_1d = safe_float(row.get("change_percent_1d"))
        row_total = safe_float(row.get("total"))
        if change_percent_1d is None or row_total is None or row_total <= 0:
            continue
        change_value += ((change_percent_1d / 100.0) * row_total) / (1.0 + (change_percent_1d / 100.0))

    denominator = total - change_value
    change_percent = (change_value / denominator) * 100.0 if denominator > 0 else 0.0

    weighted_beta = _weighted_average(held_rows, "beta")
    weighted_iv = _weighted_average(held_rows, "iv")

    sector_distribution: list[dict[str, Any]] = []
    for sector_row in sector_table:
        sector_name = str(sector_row.get("sector") or "").strip()
        if not sector_name:
            continue
        sector_distribution.append(
            {
                "sector": sector_name,
                "portfolio_weight": float(safe_float(sector_row.get("portfolio_weight")) or 0.0),
                "stock_weight": float(safe_float(sector_row.get("stock_weight")) or 0.0),
                "etf_lookthrough_weight": float(safe_float(sector_row.get("etf_lookthrough_weight")) or 0.0),
            }
        )

    return {
        "held_positions_count": len(held_rows),
        "total": total,
        "change": change_value,
        "change_percent": change_percent,
        "weighted_beta": weighted_beta,
        "weighted_iv": weighted_iv,
        "sector_distribution": sector_distribution,
    }


def _normalize_weights_to_100(weights: dict[str, float], *, decimals: int = 4) -> dict[str, float]:
    """Normalize weights so the portfolio total sums to 100 percent."""
    if not weights:
        return {}
    if sum(weights.values()) <= 0:
        return {ticker: round(weight, decimals) for ticker, weight in weights.items()}

    rounded = {ticker: round(weight, decimals) for ticker, weight in weights.items()}
    adjustment = round(100.0 - sum(rounded.values()), decimals)
    if adjustment == 0:
        return rounded

    largest_ticker = max(rounded, key=rounded.get)
    rounded[largest_ticker] = round(rounded[largest_ticker] + adjustment, decimals)
    return rounded


def _fetch_equity_sector(ticker: str) -> tuple[str, str]:
    """Fetch the sector label for one equity ticker."""
    if (cached_sector := _SECTOR_CACHE.get_fresh(ticker)) is not None:
        return ticker, cached_sector
    try:
        source = YahooFinanceSource(ticker)
        info = source.get_info_snapshot().raw_info
    except Exception:
        _SECTOR_CACHE.mark_failure(ticker)
        if (stale_sector := _SECTOR_CACHE.get_stale(ticker)) is not None:
            return ticker, stale_sector
        return ticker, normalize_sector_name(None)
    raw_sector = str(info.get("sector") or "").strip() or str(info.get("industry") or "").strip() or None
    sector_name = normalize_sector_name(raw_sector)
    _SECTOR_CACHE.set(ticker, sector_name)
    return ticker, sector_name


def _build_etf_tables(
    *,
    rows: list[dict[str, Any]],
    resolution: ETFResolutionResult,
    target_tickers: list[str],
) -> tuple[list[dict[str, float | str]], list[dict[str, float | str]], dict[str, float]]:
    """Build the ETF holdings and sector tables for the payload."""
    row_by_ticker = {str(row.get("ticker")).upper().strip(): row for row in rows if row.get("ticker")}
    stock_tickers = [str(position["ticker"]).upper().strip() for position in resolution.stock_positions]
    etf_tickers = [str(position["ticker"]).upper().strip() for position in resolution.etf_positions]

    stock_totals = {ticker: float(row_by_ticker.get(ticker, {}).get("total") or 0.0) for ticker in stock_tickers}
    etf_totals = {ticker: float(row_by_ticker.get(ticker, {}).get("total") or 0.0) for ticker in etf_tickers}
    portfolio_total = sum(stock_totals.values()) + sum(etf_totals.values())
    holding_totals = {ticker: float(row_by_ticker.get(ticker, {}).get("total") or 0.0) for ticker in target_tickers}

    direct_weights = _compute_weights(holding_totals, portfolio_total)
    etf_allocation = _compute_weights(etf_totals, portfolio_total)
    ticker_exposure: dict[str, dict[str, float]] = {
        ticker: {
            "direct_weight": direct_weights.get(ticker, 0.0),
            "etf_lookthrough_weight": 0.0,
            "combined_weight": direct_weights.get(ticker, 0.0),
        }
        for ticker in target_tickers
    }

    etf_distributed_weights = dict.fromkeys(etf_tickers, 0.0)
    etf_sector_exposure: dict[str, float] = {}
    for etf_ticker in etf_tickers:
        snapshot = resolution.snapshot_by_ticker.get(etf_ticker)
        if snapshot is None:
            continue
        etf_weight = etf_allocation.get(etf_ticker, 0.0)
        for holding in snapshot.holdings:
            holding_ticker = holding.ticker.upper().strip()
            if holding_ticker not in ticker_exposure:
                continue
            contribution = etf_weight * (holding.weight / 100.0)
            ticker_exposure[holding_ticker]["etf_lookthrough_weight"] += contribution
            ticker_exposure[holding_ticker]["combined_weight"] += contribution
            etf_distributed_weights[etf_ticker] += contribution
        for sector in snapshot.sectors:
            contribution = etf_weight * (sector.weight / 100.0)
            etf_sector_exposure[sector.name] = etf_sector_exposure.get(sector.name, 0.0) + contribution

    for etf_ticker in etf_tickers:
        if etf_ticker in ticker_exposure:
            ticker_exposure[etf_ticker]["combined_weight"] -= etf_distributed_weights.get(etf_ticker, 0.0)

    normalized_direct_weights = _normalize_weights_to_100({ticker: data["direct_weight"] for ticker, data in ticker_exposure.items()})
    normalized_combined_weights = _normalize_weights_to_100({ticker: data["combined_weight"] for ticker, data in ticker_exposure.items()})
    for ticker, data in ticker_exposure.items():
        data["direct_weight"] = normalized_direct_weights[ticker]
        data["etf_lookthrough_weight"] = round(data["etf_lookthrough_weight"], 4)
        data["combined_weight"] = normalized_combined_weights[ticker]

    stock_sector_exposure: dict[str, float] = {}
    if stock_tickers:
        with ThreadPoolExecutor(max_workers=PortfolioConfig.MAX_WORKERS) as executor:
            stock_sector_results = list(executor.map(_fetch_equity_sector, sorted(set(stock_tickers))))
        for ticker, sector_name in stock_sector_results:
            direct_weight = normalized_direct_weights.get(ticker, 0.0)
            stock_sector_exposure[sector_name] = stock_sector_exposure.get(sector_name, 0.0) + direct_weight

    ticker_table = [
        {
            "ticker": ticker,
            "direct_weight": round(data["direct_weight"], 4),
            "etf_lookthrough_weight": round(data["etf_lookthrough_weight"], 4),
            "combined_weight": round(data["combined_weight"], 4),
        }
        for ticker, data in sorted(
            ticker_exposure.items(),
            key=lambda item: item[1]["combined_weight"],
            reverse=True,
        )
    ]

    combined_sector_exposure = dict(etf_sector_exposure)
    for sector_name, weight in stock_sector_exposure.items():
        combined_sector_exposure[sector_name] = combined_sector_exposure.get(sector_name, 0.0) + weight

    etf_sleeve_total = sum(etf_sector_exposure.values())
    sector_table = [
        {
            "sector": sector,
            "stock_weight": round(stock_sector_exposure.get(sector, 0.0), 4),
            "etf_lookthrough_weight": round(etf_sector_exposure.get(sector, 0.0), 4),
            "portfolio_weight": round(weight, 4),
            "within_etf_sleeve_weight": round(((etf_sector_exposure.get(sector, 0.0) / etf_sleeve_total) * 100.0), 4) if etf_sleeve_total > 0 else 0.0,
        }
        for sector, weight in sorted(combined_sector_exposure.items(), key=lambda item: item[1], reverse=True)
    ]

    meta = {
        "direct_weight_total": round(sum(row["direct_weight"] for row in ticker_table), 4),
        "combined_weight_total": round(sum(row["combined_weight"] for row in ticker_table), 4),
        "sector_portfolio_total": round(sum(row["portfolio_weight"] for row in sector_table), 4),
        "within_etf_sleeve_total": round(sum(row["within_etf_sleeve_weight"] for row in sector_table), 4),
    }
    return ticker_table, sector_table, meta


def _normalize_positions(
    portfolio_data: Any,
    stats_data: dict[str, Any],
    *,
    include_cached_universe: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Normalize raw position rows into the expected portfolio shape."""
    positions_raw = portfolio_data if isinstance(portfolio_data, list) else portfolio_data.get("positions", [])
    positions: list[dict[str, Any]] = []
    held_positions: list[dict[str, Any]] = []
    held_tickers: list[str] = []
    seen_tickers: set[str] = set()

    for pos in positions_raw:
        if not isinstance(pos, dict):
            continue
        ticker = str(pos.get("ticker") or "").upper().strip()
        if not ticker:
            continue
        seen_tickers.add(ticker)
        held_tickers.append(ticker)
        normalized_position = {
            "ticker": ticker,
            "quantity": float(pos.get("quantity") or 0),
            "strategy": pos.get("strategy"),
            "industry_labels": [],
        }
        positions.append(normalized_position)
        held_positions.append(normalized_position)

    if include_cached_universe:
        for ticker in stats_data:
            ticker_str = str(ticker).upper().strip()
            if not ticker_str or ticker_str in seen_tickers:
                continue
            positions.append({"ticker": ticker_str, "quantity": 0.0, "_cached_only": True})

    return positions, held_positions, held_tickers


def _live_tickers(
    positions: list[dict[str, Any]],
    *,
    include_live_market: bool,
) -> list[str]:
    """Return the tickers that require live market refreshes."""
    if not include_live_market:
        return []

    tickers: list[str] = []
    for position in positions:
        ticker = _ticker_key(position.get("ticker", ""))
        if not ticker:
            continue
        cached_only = bool(position.get("_cached_only"))
        quantity = float(position.get("quantity") or 0)
        if cached_only or quantity <= 0:
            continue
        tickers.append(ticker)
    return list(dict.fromkeys(tickers))


def _rank_rows(rows: list[dict[str, Any]]) -> None:
    """Rank dashboard rows using the configured sort rules."""
    scored_rows: list[tuple[int, float]] = []
    for idx, row in enumerate(rows):
        overall_score = row.get("overall_score")
        if overall_score is None:
            continue
        try:
            scored_rows.append((idx, float(overall_score)))
        except (TypeError, ValueError):
            continue
    scored_rows.sort(key=lambda item: item[1], reverse=True)
    for rank, (idx, _) in enumerate(scored_rows, start=1):
        rows[idx]["rank"] = rank


def _load_payload_inputs(
    *,
    portfolio_path: str | Path | None,
    stats_path: str | Path | None,
    eval_path: str | Path | None,
    include_cached_universe: bool,
) -> PortfolioPayloadInputs:
    """Load the portfolio, stats, and evaluation inputs for payload building."""
    _ = portfolio_path, stats_path, eval_path
    portfolio_data = load_positions_store()
    requested_tickers = None if include_cached_universe else _portfolio_tickers(portfolio_data)
    stats_data, eval_data = load_stock_families(tickers=requested_tickers)
    positions, held_positions, held_tickers = _normalize_positions(
        portfolio_data,
        stats_data,
        include_cached_universe=include_cached_universe,
    )
    return PortfolioPayloadInputs(
        stats_data=stats_data,
        eval_data=eval_data,
        positions=positions,
        held_positions=held_positions,
        held_tickers=held_tickers,
    )


def _build_rows(
    *,
    positions: list[dict[str, Any]],
    stats_data: dict[str, Any],
    eval_data: dict[str, Any],
    live_map: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build dashboard rows for the requested ticker universe."""
    return [
        _build_row(
            position,
            stats_data,
            eval_data,
            live_market=live_map.get(_ticker_key(position.get("ticker", ""))),
        )
        for position in positions
    ]


def _apply_position_labels(
    *,
    positions: list[dict[str, Any]],
    labels_by_ticker: dict[str, list[str]],
) -> None:
    """Attach resolved labels back onto each dashboard row."""
    for position in positions:
        ticker = _ticker_key(position.get("ticker", ""))
        if not ticker:
            continue
        position["industry_labels"] = normalize_labels(labels_by_ticker.get(ticker, []))


def _finalize_rows(rows: list[dict[str, Any]]) -> None:
    """Finalize row ordering and derived display fields."""
    total_value = sum(float(row.get("total") or 0.0) for row in rows)
    for row in rows:
        row["weight_pct"] = calculate_position_weight(float(row.get("total") or 0.0), total_value)
    _rank_rows(rows)
    rows.sort(key=lambda row: float(row.get("weight_pct") or 0.0), reverse=True)


def _build_payload_from_rows(
    *,
    rows: list[dict[str, Any]],
    resolution: ETFResolutionResult,
    sector_table: list[dict[str, float | str]],
    ticker_table: list[dict[str, float | str]],
    table_meta: dict[str, float],
    generated_at: str,
    data_source: str,
) -> dict[str, Any]:
    """Assemble the final portfolio payload from prepared rows."""
    return {
        "rows": rows,
        "tables": {
            "ticker_exposure": ticker_table,
            "sector_exposure": sector_table,
        },
        "portfolio_stats": _build_portfolio_stats(rows, sector_table),
        "meta": {
            **table_meta,
            "etf_count": len(resolution.etf_positions),
            "etf_refreshed_count": resolution.etf_refreshed_count,
            "generated_at": generated_at,
            "data_source": data_source,
        },
    }


def _merge_live_results_into_stats_data(
    *,
    stats_data: dict[str, Any],
    live_results: Mapping[str, StatsResolutionResult],
) -> None:
    """Merge resolved live rows back into the broader cached stats map."""
    for ticker, result in live_results.items():
        existing = stats_data.get(ticker)
        merged = dict(existing) if isinstance(existing, dict) else {}
        merged.update(result.row)
        stats_data[ticker] = merged


def _portfolio_payload_data_source(
    *,
    rows: list[dict[str, Any]],
    live_results: Mapping[str, StatsResolutionResult],
    include_live_market: bool,
) -> str:
    """Classify the payload source from all rows included in the response."""
    if not include_live_market:
        return "cache"

    aggregated = aggregate_data_source(live_results, mode="auto")
    if aggregated != "live":
        return aggregated

    live_tickers = set(live_results)
    for row in rows:
        ticker = _ticker_key(str(row.get("ticker") or ""))
        if ticker and ticker not in live_tickers:
            return "live_with_cache_fallback"
    return "live"


def _build_live_map(live_results: Mapping[str, StatsResolutionResult]) -> dict[str, dict[str, Any]]:
    """Flatten resolver results into the row-level live override map."""
    return {ticker: dict(result.row) for ticker, result in live_results.items()}


def _persist_portfolio_cache_updates(
    *,
    stats_data: dict[str, Any],
    now: datetime,
    resolution: ETFResolutionResult,
) -> None:
    """Persist ETF cache changes made during payload assembly."""
    if not resolution.cache_changed:
        return
    changed_rows = {ticker: dict(stats_data.get(ticker) or {}) for ticker in resolution.changed_tickers if isinstance(stats_data.get(ticker), dict)}
    upsert_stats_rows(
        changed_rows,
        timestamp=now.isoformat(),
        update_generated_at=True,
    )


def _assemble_portfolio_payload(
    *,
    inputs: PortfolioPayloadInputs,
    labels_by_ticker: dict[str, list[str]],
    live_results: Mapping[str, StatsResolutionResult],
    include_live_market: bool,
) -> dict[str, Any]:
    """Build the final payload once inputs, labels, and live results are ready."""
    _apply_position_labels(positions=inputs.positions, labels_by_ticker=labels_by_ticker)
    _merge_live_results_into_stats_data(stats_data=inputs.stats_data, live_results=live_results)
    rows = _build_rows(
        positions=inputs.positions,
        stats_data=inputs.stats_data,
        eval_data=inputs.eval_data,
        live_map=_build_live_map(live_results),
    )
    _finalize_rows(rows)

    now = datetime.now(tz=UTC)
    resolution = classify_and_resolve_etfs(
        inputs.held_positions,
        inputs.stats_data,
        now,
        allow_live_fetch=include_live_market,
    )
    _persist_portfolio_cache_updates(
        stats_data=inputs.stats_data,
        now=now,
        resolution=resolution,
    )

    ticker_table, sector_table, table_meta = _build_etf_tables(
        rows=rows,
        resolution=resolution,
        target_tickers=[ticker for ticker in inputs.held_tickers if ticker],
    )
    return _build_payload_from_rows(
        rows=rows,
        resolution=resolution,
        sector_table=sector_table,
        ticker_table=ticker_table,
        table_meta=table_meta,
        generated_at=now.isoformat(),
        data_source=_portfolio_payload_data_source(
            rows=rows,
            live_results=live_results,
            include_live_market=include_live_market,
        ),
    )


def get_portfolio_payload(
    portfolio_path: str | Path | None = None,
    stats_path: str | Path | None = None,
    eval_path: str | Path | None = None,
    include_cached_universe: bool = True,
    include_live_market: bool = True,
) -> dict[str, Any]:
    """Return the portfolio dashboard payload."""
    inputs = _load_payload_inputs(
        portfolio_path=portfolio_path,
        stats_path=stats_path,
        eval_path=eval_path,
        include_cached_universe=include_cached_universe,
    )
    labels_by_ticker = resolve_portfolio_labels(
        inputs.held_positions,
        fetch_missing=include_live_market,
        stats_data=inputs.stats_data,
    )
    live_tickers = _live_tickers(inputs.positions, include_live_market=include_live_market)
    live_results = resolve_ticker_stats_map(
        live_tickers,
        mode="auto",
        persisted_rows=inputs.stats_data,
    )
    return _assemble_portfolio_payload(
        inputs=inputs,
        labels_by_ticker=labels_by_ticker,
        live_results=live_results,
        include_live_market=include_live_market,
    )


async def get_portfolio_payload_async(
    portfolio_path: str | Path | None = None,
    stats_path: str | Path | None = None,
    eval_path: str | Path | None = None,
    include_cached_universe: bool = True,
    include_live_market: bool = True,
) -> dict[str, Any]:
    """Return the portfolio dashboard payload asynchronously."""
    inputs = await asyncio.to_thread(
        _load_payload_inputs,
        portfolio_path=portfolio_path,
        stats_path=stats_path,
        eval_path=eval_path,
        include_cached_universe=include_cached_universe,
    )
    labels_by_ticker = await resolve_portfolio_labels_async(
        inputs.held_positions,
        fetch_missing=include_live_market,
        stats_data=inputs.stats_data,
    )
    live_tickers = _live_tickers(inputs.positions, include_live_market=include_live_market)
    live_results = await resolve_ticker_stats_map_async(
        live_tickers,
        mode="auto",
        persisted_rows=inputs.stats_data,
    )
    return await asyncio.to_thread(
        _assemble_portfolio_payload,
        inputs=inputs,
        labels_by_ticker=labels_by_ticker,
        live_results=live_results,
        include_live_market=include_live_market,
    )


def build_portfolio_dataframe(
    portfolio_path: str | Path | None = None,
    stats_path: str | Path | None = None,
    eval_path: str | Path | None = None,
    include_cached_universe: bool = True,
    include_live_market: bool = True,
) -> pd.DataFrame:
    """Build a dataframe view of the portfolio payload."""
    payload = get_portfolio_payload(
        portfolio_path=portfolio_path,
        stats_path=stats_path,
        eval_path=eval_path,
        include_cached_universe=include_cached_universe,
        include_live_market=include_live_market,
    )
    dataframe = pd.DataFrame(payload.get("rows", []))
    if not dataframe.empty:
        dataframe = dataframe.sort_values(by="weight_pct", ascending=False, na_position="last")
    return dataframe


def get_dashboard(
    portfolio_path: str | Path | None = None,
    stats_path: str | Path | None = None,
    eval_path: str | Path | None = None,
    include_cached_universe: bool = True,
    include_live_market: bool = True,
) -> pd.DataFrame:
    """Return a Rich table representation of the portfolio dashboard."""
    return build_portfolio_dataframe(
        portfolio_path=portfolio_path,
        stats_path=stats_path,
        eval_path=eval_path,
        include_cached_universe=include_cached_universe,
        include_live_market=include_live_market,
    )


def get_weighted_indicators(
    indicators: Sequence[str] | None = None,
    *,
    portfolio_path: str | Path | None = None,
    stats_path: str | Path | None = None,
    eval_path: str | Path | None = None,
    include_cached_universe: bool = False,
) -> dict[str, float | None]:
    """Return weighted indicator averages for the portfolio.

    Weights are derived from each row's `weight_pct` and re-normalized over rows
    with valid numeric values for each indicator.
    """
    indicator_names = [name.strip() for name in (indicators or ["beta"]) if str(name).strip()]
    if not indicator_names:
        return {}

    dataframe = get_dashboard(
        portfolio_path=portfolio_path,
        stats_path=stats_path,
        eval_path=eval_path,
        include_cached_universe=include_cached_universe,
    )
    if dataframe.empty or "weight_pct" not in dataframe.columns:
        return dict.fromkeys(indicator_names)

    weights = pd.to_numeric(dataframe["weight_pct"], errors="coerce")
    weighted: dict[str, float | None] = {}

    for indicator in indicator_names:
        if indicator not in dataframe.columns:
            weighted[indicator] = None
            continue

        values = pd.to_numeric(dataframe[indicator], errors="coerce")
        valid_mask = weights.notna() & values.notna() & (weights > 0)
        if not valid_mask.any():
            weighted[indicator] = None
            continue

        active_weights = weights[valid_mask]
        active_values = values[valid_mask]
        weighted[indicator] = float((active_values * active_weights).sum() / active_weights.sum())

    return weighted


def display_dashboard(
    portfolio_path: str | Path | None = None,
    stats_path: str | Path | None = None,
    eval_path: str | Path | None = None,
) -> None:
    """Render the portfolio dashboard to the console."""
    dataframe = get_dashboard(
        portfolio_path=portfolio_path,
        stats_path=stats_path,
        eval_path=eval_path,
    )

    console = Console()
    table = Table(title="Portfolio Dashboard", box=box.ROUNDED, header_style="bold magenta")

    def fmt_pct(value: Any) -> str:
        """Format a percentage value for display."""
        if (parsed := safe_float(value)) is None:
            return "-"
        color = "green" if parsed >= 0 else "red"
        return f"[{color}]{parsed:.2f}%[/{color}]"

    def fmt_curr(value: Any) -> str:
        """Format a currency value for display."""
        if (parsed := safe_float(value)) is None:
            return "-"
        return f"${parsed:,.2f}"

    def fmt_num(value: Any) -> str:
        """Format a numeric value for display."""
        if (parsed := safe_float(value)) is None:
            return "-"
        return f"{parsed:.2f}"

    table.add_column("Ticker", style="cyan", no_wrap=True)
    table.add_column("Qty", justify="right")
    table.add_column("Price", justify="right")
    table.add_column("Change %", justify="right")
    table.add_column("RSI", justify="right")
    table.add_column("1M %", justify="right")
    table.add_column("3M %", justify="right")
    table.add_column("6M %", justify="right")
    table.add_column("1Y %", justify="right")
    table.add_column("Upside", justify="right")
    table.add_column("Total", justify="right")
    table.add_column("Weight %", justify="right")

    for _, row in dataframe.iterrows():
        table.add_row(
            str(row["ticker"]),
            str(row["quantity"]),
            fmt_curr(row["price"]),
            fmt_pct(row["change_percent_1d"]),
            fmt_num(row["rsi"]),
            fmt_pct(row["change_percent_1m"]),
            fmt_pct(row["change_percent_3m"]),
            fmt_pct(row["change_percent_6m"]),
            fmt_pct(row["change_percent_1y"]),
            fmt_pct(row["median_upside"]),
            fmt_curr(row["total"]),
            fmt_pct(row["weight_pct"]),
        )

    console.print(table)
