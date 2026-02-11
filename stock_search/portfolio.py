from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from time import monotonic, sleep
from typing import Any

import pandas as pd
from rich import box
from rich.console import Console
from rich.table import Table

from stock_search.cache import TieredCache
from stock_search.common_utils import clamp, safe_float
from stock_search.config import CacheConfig, PortfolioConfig, UpdateTierLabels
from stock_search.data_sources.yahoofinance import YahooFinanceSource
from stock_search.evaluation.constants import (
    DEFAULT_BEAR_PROBABILITY,
    DEFAULT_BULL_PROBABILITY,
    DEFAULT_SCORE,
    CalibrationConfig,
)
from stock_search.evaluation.normalization import bucket_from_eval_json, normalize_eval_json
from stock_search.field_definitions import EVAL_FIELD_DEFINITIONS, MARKET_FIELDS
from stock_search.file_utils import load_json

_HISTORY_CACHE = TieredCache[dict[str, Any]](
    ttl_seconds=CacheConfig.HISTORY_TTL_SECONDS,
    stale_seconds=CacheConfig.HISTORY_STALE_SECONDS,
    failure_cooldown_seconds=CacheConfig.HISTORY_FAILURE_COOLDOWN_SECONDS,
)
_INFO_CACHE = TieredCache[dict[str, Any]](
    ttl_seconds=CacheConfig.INFO_TTL_SECONDS,
    stale_seconds=CacheConfig.INFO_STALE_SECONDS,
    failure_cooldown_seconds=CacheConfig.INFO_FAILURE_COOLDOWN_SECONDS,
)
_LIVE_STATS_RATE_LOCK = Lock()
_LAST_LIVE_STATS_REQUEST_AT = 0.0


def calculate_notional(quantity: float, delta: float, current_price: float) -> float:
    """
    Calculate notional exposure from shares plus option-equivalent shares.

    Args:
        quantity: Number of underlying shares held
        delta: Net option delta in contract units; each 1.0 adds 100 share-equivalents
        current_price: Current price in USD

    Returns:
        Notional exposure in USD
    """
    effective_shares = quantity + (delta * 100.0)
    return effective_shares * current_price


def calculate_position_weight(notional: float, total_equity: float) -> float:
    """
    Calculate position weight as % of equity.

    Args:
        notional: Notional exposure
        total_equity: Total equity

    Returns:
        Weight as percentage
    """
    if total_equity <= 0:
        return 0.0
    return (notional / total_equity) * 100


def _map_linear(
    value: float | None,
    *,
    in_min: float,
    in_max: float,
    out_min: float,
    out_max: float,
) -> float | None:
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
        "change_percent",
        "one_month_change_percent",
        "three_month_change_percent",
        "six_month_change_percent",
        "one_year_change_percent",
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
        "overall": round(overall, 2),
        "quality": round(quality, 2),
        "valuation": round(valuation, 2),
        "moat": round(moat, 2),
        "upside": round(upside, 2),
        "bull": round(bull, 4),
        "bear": round(bear, 4),
    }


def _pick_eval_value(
    *,
    eval_data: dict[str, Any],
    normalized_eval: dict[str, Any],
    fallback_eval: dict[str, float],
    key: str,
    aliases: tuple[str, ...] = (),
) -> tuple[float, bool]:
    has_llm_value = any(alias in eval_data and eval_data.get(alias) is not None for alias in (key, *aliases))
    if has_llm_value and key in normalized_eval:
        return float(normalized_eval[key]), True
    return float(fallback_eval[key]), False


def _rate_limit_wait() -> None:
    if CacheConfig.LIVE_STATS_MIN_REQUEST_GAP_SECONDS <= 0:
        return
    global _LAST_LIVE_STATS_REQUEST_AT
    with _LIVE_STATS_RATE_LOCK:
        elapsed = monotonic() - _LAST_LIVE_STATS_REQUEST_AT
        wait_seconds = CacheConfig.LIVE_STATS_MIN_REQUEST_GAP_SECONDS - elapsed
        if wait_seconds > 0:
            sleep(wait_seconds)
        _LAST_LIVE_STATS_REQUEST_AT = monotonic()


def _fetch_live_stats(ticker: str) -> dict[str, Any]:
    """Fetch tiered market stats for a ticker (history + info)."""
    ticker_key = str(ticker).upper().strip()
    now = datetime.now(tz=UTC)
    history_data = _HISTORY_CACHE.get_fresh(ticker_key, now=now)
    info_data = _INFO_CACHE.get_fresh(ticker_key, now=now)
    need_history_fetch = history_data is None and _HISTORY_CACHE.should_retry(ticker_key, now=now)
    need_info_fetch = info_data is None and _INFO_CACHE.should_retry(ticker_key, now=now)

    if history_data is None:
        history_data = _HISTORY_CACHE.get_stale(ticker_key, now=now) or {}
    else:
        history_data = dict(history_data)

    if info_data is None:
        info_data = _INFO_CACHE.get_stale(ticker_key, now=now) or {}
    else:
        info_data = dict(info_data)

    if not need_history_fetch and not need_info_fetch:
        return {**info_data, **history_data}

    yahoo_source = YahooFinanceSource(ticker_key) if (need_history_fetch or need_info_fetch) else None

    if need_history_fetch:
        _rate_limit_wait()
        try:
            latest_price = yahoo_source.get_realtime_price(yahoo_source.get_market_state()) or yahoo_source.get_current_price()
            previous_close = yahoo_source.get_previous_close()
            change = None
            change_percent = None
            if latest_price is not None and previous_close not in (None, 0):
                change = round(latest_price - previous_close, 2)
                change_percent = round(((latest_price - previous_close) / previous_close) * 100, 2)
            fetched_history = {
                **history_data,
                "price": latest_price,
                "change": change,
                "change_percent": change_percent,
            }
            _HISTORY_CACHE.set(ticker_key, fetched_history, now=now)
            history_data = dict(fetched_history)
        except Exception:
            _HISTORY_CACHE.mark_failure(ticker_key, now=now)
            history_data = _HISTORY_CACHE.get_stale(ticker_key, now=now) or {}

    if need_info_fetch:
        try:
            quote_type = yahoo_source.get_quote_type()
            fetched_info = {
                **info_data,
                "name": yahoo_source.info.get("shortName") or yahoo_source.info.get("longName"),
                "current_price": yahoo_source.get_current_price(),
                "quote_type": quote_type or None,
                "market_cap": yahoo_source.get_market_cap(),
                "pe": yahoo_source.get_pe_trailing(),
                "pe_forward": yahoo_source.get_forward_pe_ntm(),
                "peg": yahoo_source.get_peg(),
                "beta": yahoo_source.get_beta(),
                "debt_to_equity": yahoo_source.get_debt_to_equity_percent(),
                "free_cash_flow": yahoo_source.get_free_cash_flow_in_quote_currency(),
            }
            fetched_info["quote_type"] = quote_type or None
            if quote_type == "ETF":
                fetched_info["pe_forward"] = None
            _INFO_CACHE.set(ticker_key, fetched_info, now=now)
            info_data = dict(fetched_info)
        except Exception:
            _INFO_CACHE.mark_failure(ticker_key, now=now)
            info_data = _INFO_CACHE.get_stale(ticker_key, now=now) or {}

    merged = {**info_data, **history_data}
    return {k: v for k, v in merged.items() if v is not None or k == "pe_forward"}


def _derive_bucket_from_eval(ticker: str, eval_data: dict[str, Any]) -> str | None:
    return bucket_from_eval_json(ticker, eval_data)


def _build_row(
    pos: dict[str, Any],
    stats_cache: dict[str, Any],
    eval_cache: dict[str, Any],
    *,
    include_live_market: bool,
) -> dict[str, Any]:
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

    cached_only = bool(pos.get("_cached_only"))
    # Background/refresh live fetches are only needed for active holdings.
    should_fetch_live_market = include_live_market and not cached_only and qty > 0
    live_market = _fetch_live_stats(ticker) if should_fetch_live_market else {}

    stats: dict[str, Any] = {**cached_meta, **cached_market, **live_market}

    delta = float(pos.get("delta") if pos.get("delta") is not None else 0.0)
    price = stats.get("current_price") or stats.get("price")

    notional = calculate_notional(qty, delta, price) if qty and price else 0.0

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

    bucket = pos.get("bucket") or _derive_bucket_from_eval(ticker, eval_data) or stats.get("bucket")
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
        "overall": selected_eval["overall"],
        "quality": selected_eval["quality"],
        "valuation": selected_eval["valuation"],
        "moat": selected_eval["moat"],
        "upside": selected_eval["upside"],
        "market_cap_score": normalized_eval.get("market_cap_score"),
        "bull": selected_eval["bull"],
        "bear": selected_eval["bear"],
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
        "delta": delta,
        "current_price": price,
        "change": stats.get("change"),
        "change_percent": stats.get("change_percent"),
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
        "one_month_change_percent": stats.get("one_month_change_percent"),
        "three_month_change_percent": stats.get("three_month_change_percent"),
        "six_month_change_percent": stats.get("six_month_change_percent"),
        "one_year_change_percent": stats.get("one_year_change_percent"),
        "median_upside": stats.get("median_upside"),
        "etf_holdings": etf_holdings,
        "etf_holdings_fetched_at": etf_holdings_fetched_at,
        "bucket": bucket,
        "notional": notional,
        "weight_pct": None,
    }


def build_portfolio_dataframe(
    portfolio_path: str | Path = "data/portfolio.json",
    stats_path: str | Path = "data/stats.json",
    eval_path: str | Path = "data/eval.json",
    include_cached_universe: bool = True,
    include_live_market: bool = True,
) -> pd.DataFrame:
    portfolio_data = load_json(portfolio_path, default=[])

    stats_data = load_json(stats_path, default={})
    if not isinstance(stats_data, dict):
        stats_data = {}

    eval_data_raw = load_json(eval_path, default={})
    eval_data: dict[str, Any] = {}
    if isinstance(eval_data_raw, dict):
        eval_data = eval_data_raw
    elif isinstance(eval_data_raw, list):
        for item in eval_data_raw:
            if isinstance(item, dict) and (ticker := item.get("ticker")):
                eval_data[str(ticker)] = item

    positions_raw = portfolio_data if isinstance(portfolio_data, list) else portfolio_data.get("positions", [])

    positions: list[dict[str, Any]] = []
    seen_tickers: set[str] = set()

    for pos in positions_raw:
        if not isinstance(pos, dict):
            continue
        ticker = str(pos.get("ticker") or "").upper().strip()
        if not ticker:
            continue
        seen_tickers.add(ticker)
        positions.append(
            {
                **pos,
                "ticker": ticker,
                "quantity": float(pos.get("quantity") or 0),
                "delta": float(pos.get("delta") if pos.get("delta") is not None else 0.0),
            }
        )

    if include_cached_universe:
        for ticker in stats_data:
            ticker_str = str(ticker).upper().strip()
            if not ticker_str or ticker_str in seen_tickers:
                continue
            positions.append(
                {
                    "ticker": ticker_str,
                    "quantity": 0.0,
                    "delta": 0.0,
                    "_cached_only": True,
                }
            )

    with ThreadPoolExecutor(max_workers=PortfolioConfig.MAX_WORKERS) as executor:
        rows = list(
            executor.map(
                lambda pos: _build_row(
                    pos,
                    stats_data,
                    eval_data,
                    include_live_market=include_live_market,
                ),
                positions,
            )
        )

    total_notional = sum(row.get("notional", 0) for row in rows)
    for row in rows:
        row["weight_pct"] = calculate_position_weight(row.get("notional", 0), total_notional)

    scored_rows: list[tuple[int, float]] = []
    for idx, row in enumerate(rows):
        overall = row.get("overall")
        if overall is None:
            continue
        try:
            scored_rows.append((idx, float(overall)))
        except (TypeError, ValueError):
            continue

    scored_rows.sort(key=lambda item: item[1], reverse=True)
    for rank, (idx, _) in enumerate(scored_rows, start=1):
        rows[idx]["rank"] = rank

    dataframe = pd.DataFrame(rows)
    if not dataframe.empty:
        dataframe = dataframe.sort_values(by="weight_pct", ascending=False, na_position="last")

    return dataframe


def get_dashboard(
    portfolio_path: str | Path = "data/portfolio.json",
    stats_path: str | Path = "data/stats.json",
    eval_path: str | Path = "data/eval.json",
    include_cached_universe: bool = True,
    include_live_market: bool = True,
) -> pd.DataFrame:
    """Backward-compatible name for dashboard/API callers."""
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
    portfolio_path: str | Path = "data/portfolio.json",
    stats_path: str | Path = "data/stats.json",
    eval_path: str | Path = "data/eval.json",
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
    portfolio_path: str | Path = "data/portfolio.json",
    stats_path: str | Path = "data/stats.json",
    eval_path: str | Path = "data/eval.json",
) -> None:
    dataframe = get_dashboard(
        portfolio_path=portfolio_path,
        stats_path=stats_path,
        eval_path=eval_path,
    )

    console = Console()
    table = Table(title="Portfolio Dashboard", box=box.ROUNDED, header_style="bold magenta")

    def fmt_pct(value: Any) -> str:
        if (parsed := safe_float(value)) is None:
            return "-"
        color = "green" if parsed >= 0 else "red"
        return f"[{color}]{parsed:.2f}%[/{color}]"

    def fmt_curr(value: Any) -> str:
        if (parsed := safe_float(value)) is None:
            return "-"
        return f"${parsed:,.2f}"

    def fmt_num(value: Any) -> str:
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
    table.add_column("Notional", justify="right")
    table.add_column("Weight %", justify="right")

    for _, row in dataframe.iterrows():
        table.add_row(
            str(row["ticker"]),
            str(row["quantity"]),
            fmt_curr(row["current_price"]),
            fmt_pct(row["change_percent"]),
            fmt_num(row["rsi"]),
            fmt_pct(row["one_month_change_percent"]),
            fmt_pct(row["three_month_change_percent"]),
            fmt_pct(row["six_month_change_percent"]),
            fmt_pct(row["one_year_change_percent"]),
            fmt_pct(row["median_upside"]),
            fmt_curr(row["notional"]),
            fmt_pct(row["weight_pct"]),
        )

    console.print(table)
