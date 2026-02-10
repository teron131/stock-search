from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Lock
from time import monotonic, sleep
from typing import Any

import pandas as pd
from rich import box
from rich.console import Console
from rich.table import Table

from stock_search.evaluation.constants import (
    DEFAULT_BEAR_PROBABILITY,
    DEFAULT_BULL_PROBABILITY,
    DEFAULT_SCORE,
    CalibrationConfig,
)
from stock_search.evaluation.evaluation import (
    bucket_from_eval_json,
    normalize_eval_json,
)
from stock_search.file_utils import load_json
from stock_search.indicators import StockIndicator
from stock_search.portfolio import calculate_notional

_MAX_WORKERS = 5
_HISTORY_TTL_SECONDS = 60
_HISTORY_STALE_SECONDS = 600
_HISTORY_FAILURE_COOLDOWN_SECONDS = 180
_INFO_TTL_SECONDS = 3_600  # 1 hour
_INFO_STALE_SECONDS = 172_800  # 48 hours
_INFO_FAILURE_COOLDOWN_SECONDS = 1_800  # 30 minutes
_RATINGS_TTL_SECONDS = 86_400  # 1 day
_RATINGS_STALE_SECONDS = 604_800  # 7 days
_RATINGS_FAILURE_COOLDOWN_SECONDS = 21_600  # 6 hours
_LIVE_STATS_MIN_REQUEST_GAP_SECONDS = 0.3
_HISTORY_CACHE: dict[str, tuple[datetime, dict[str, Any]]] = {}
_HISTORY_FAILURES: dict[str, datetime] = {}
_INFO_CACHE: dict[str, tuple[datetime, dict[str, Any]]] = {}
_INFO_FAILURES: dict[str, datetime] = {}
_RATINGS_CACHE: dict[str, tuple[datetime, dict[str, Any]]] = {}
_RATINGS_FAILURES: dict[str, datetime] = {}
_LIVE_STATS_CACHE_LOCK = Lock()
_LIVE_STATS_RATE_LOCK = Lock()
_LAST_LIVE_STATS_REQUEST_AT = 0.0

_MARKET_KEYS = {
    "price",
    "current_price",
    "change",
    "change_percent",
    "market_cap",
    "pe",
    "pe_forward",
    "peg",
    "beta",
    "iv",
    "debt_to_equity",
    "free_cash_flow",
    "revenue_growth",
    "gross_margin",
    "rsi",
    "one_month_change_percent",
    "three_month_change_percent",
    "six_month_change_percent",
    "one_year_change_percent",
    "mtd_change_percent",
    "ytd_change_percent",
    "median_upside",
}

_HISTORY_FIELDS = {
    "price",
    "change",
    "change_percent",
    "iv",
    "rsi",
    "one_month_change_percent",
    "three_month_change_percent",
    "six_month_change_percent",
    "one_year_change_percent",
    "mtd_change_percent",
    "ytd_change_percent",
}
_INFO_FIELDS = {
    "market_cap",
    "pe",
    "pe_forward",
    "peg",
    "beta",
    "debt_to_equity",
    "free_cash_flow",
    "revenue_growth",
    "gross_margin",
}
_RATINGS_FIELDS = {
    "median_upside",
}

_UPDATE_TIER_FAST_LABEL = "history_1m"
_UPDATE_TIER_SLOW_LABEL = "info_1h"
_UPDATE_TIER_RATINGS_LABEL = "ratings_1d"
_UPDATE_TIER_EVAL_LABEL = "llm_optional"
_UPDATE_TIER_ETF_HOLDINGS_LABEL = "llm_optional"


def _clamp_score(value: float) -> float:
    return max(0.0, min(10.0, value))


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
    valuation = _clamp_score(sum(valuation_values) / len(valuation_values)) if valuation_values else DEFAULT_SCORE

    quality_parts = [
        _map_linear(revenue_growth, in_min=rev_g_min, in_max=rev_g_max, out_min=2.0, out_max=10.0),
        _map_linear(gross_margin, in_min=margin_min, in_max=margin_max, out_min=2.0, out_max=10.0),
    ]
    quality_values = [v for v in quality_parts if v is not None]
    quality = _clamp_score(sum(quality_values) / len(quality_values)) if quality_values else DEFAULT_SCORE

    upside_val = _map_linear(median_upside, in_min=upside_min, in_max=upside_max, out_min=2.0, out_max=10.0)
    upside = _clamp_score(upside_val) if upside_val is not None else DEFAULT_SCORE

    moat = DEFAULT_SCORE
    overall = _clamp_score((moat + quality + valuation + upside) / 4)

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
    global _LAST_LIVE_STATS_REQUEST_AT
    with _LIVE_STATS_RATE_LOCK:
        elapsed = monotonic() - _LAST_LIVE_STATS_REQUEST_AT
        wait_seconds = _LIVE_STATS_MIN_REQUEST_GAP_SECONDS - elapsed
        if wait_seconds > 0:
            sleep(wait_seconds)
        _LAST_LIVE_STATS_REQUEST_AT = monotonic()


def _fetch_fields(indicator: StockIndicator, fields: set[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for field in fields:
        with suppress(Exception):
            out[field] = getattr(indicator, field)
    return out


def _fetch_live_stats(ticker: str) -> dict[str, Any]:
    """Fetch tiered market stats for a ticker (history + info + ratings)."""
    ticker_key = str(ticker).upper().strip()
    now = datetime.now(tz=UTC)
    history_ttl_cutoff = now - timedelta(seconds=_HISTORY_TTL_SECONDS)
    history_stale_cutoff = now - timedelta(seconds=_HISTORY_STALE_SECONDS)
    history_failure_cutoff = now - timedelta(seconds=_HISTORY_FAILURE_COOLDOWN_SECONDS)
    info_ttl_cutoff = now - timedelta(seconds=_INFO_TTL_SECONDS)
    info_stale_cutoff = now - timedelta(seconds=_INFO_STALE_SECONDS)
    info_failure_cutoff = now - timedelta(seconds=_INFO_FAILURE_COOLDOWN_SECONDS)
    ratings_ttl_cutoff = now - timedelta(seconds=_RATINGS_TTL_SECONDS)
    ratings_stale_cutoff = now - timedelta(seconds=_RATINGS_STALE_SECONDS)
    ratings_failure_cutoff = now - timedelta(seconds=_RATINGS_FAILURE_COOLDOWN_SECONDS)

    with _LIVE_STATS_CACHE_LOCK:
        history_entry = _HISTORY_CACHE.get(ticker_key)
        info_entry = _INFO_CACHE.get(ticker_key)
        ratings_entry = _RATINGS_CACHE.get(ticker_key)
        history_failure = _HISTORY_FAILURES.get(ticker_key)
        info_failure = _INFO_FAILURES.get(ticker_key)
        ratings_failure = _RATINGS_FAILURES.get(ticker_key)

    history_data = dict(history_entry[1]) if history_entry else {}
    info_data = dict(info_entry[1]) if info_entry else {}
    ratings_data = dict(ratings_entry[1]) if ratings_entry else {}
    history_fresh = bool(history_entry and history_entry[0] >= history_ttl_cutoff)
    info_fresh = bool(info_entry and info_entry[0] >= info_ttl_cutoff)
    ratings_fresh = bool(ratings_entry and ratings_entry[0] >= ratings_ttl_cutoff)
    history_recent_failure = bool(history_failure and history_failure >= history_failure_cutoff)
    info_recent_failure = bool(info_failure and info_failure >= info_failure_cutoff)
    ratings_recent_failure = bool(ratings_failure and ratings_failure >= ratings_failure_cutoff)

    # Most refreshes should be served from cache without live calls.
    if history_fresh and info_fresh and ratings_fresh:
        return {**info_data, **ratings_data, **history_data}

    def has_history_stale() -> bool:
        return bool(history_entry and history_entry[0] >= history_stale_cutoff)

    def has_info_stale() -> bool:
        return bool(info_entry and info_entry[0] >= info_stale_cutoff)

    def has_ratings_stale() -> bool:
        return bool(ratings_entry and ratings_entry[0] >= ratings_stale_cutoff)

    need_history_fetch = not history_fresh and not history_recent_failure
    need_info_fetch = not info_fresh and not info_recent_failure
    need_ratings_fetch = not ratings_fresh and not ratings_recent_failure

    # If either tier recently failed, keep stale values and skip re-hammering.
    if history_recent_failure and not has_history_stale():
        history_data = {}
    if info_recent_failure and not has_info_stale():
        info_data = {}
    if ratings_recent_failure and not has_ratings_stale():
        ratings_data = {}

    # Cold-start priority: history -> info -> ratings
    indicator = StockIndicator(ticker) if (need_history_fetch or need_info_fetch or need_ratings_fetch) else None

    if need_history_fetch:
        _rate_limit_wait()
        try:
            fetched_history = _fetch_fields(indicator, _HISTORY_FIELDS)
            with _LIVE_STATS_CACHE_LOCK:
                _HISTORY_CACHE[ticker_key] = (now, fetched_history)
                _HISTORY_FAILURES.pop(ticker_key, None)
                history_data = dict(fetched_history)
        except Exception:
            with _LIVE_STATS_CACHE_LOCK:
                _HISTORY_FAILURES[ticker_key] = now
                history_data = dict(_HISTORY_CACHE[ticker_key][1]) if has_history_stale() else {}

    if need_info_fetch:
        _rate_limit_wait()
        try:
            fetched_info = _fetch_fields(indicator, _INFO_FIELDS)
            fetched_info["name"] = indicator.info.get("shortName") or indicator.info.get("longName")
            if "current_price" not in history_data:
                fetched_info["current_price"] = indicator._current_price_from_info()
            quote_type = str(indicator.info.get("quoteType") or "").upper()
            fetched_info["quote_type"] = quote_type or None
            if quote_type == "ETF":
                fetched_info["pe_forward"] = None
            with _LIVE_STATS_CACHE_LOCK:
                _INFO_CACHE[ticker_key] = (now, fetched_info)
                _INFO_FAILURES.pop(ticker_key, None)
                info_data = dict(fetched_info)
        except Exception:
            with _LIVE_STATS_CACHE_LOCK:
                _INFO_FAILURES[ticker_key] = now
                info_data = dict(_INFO_CACHE[ticker_key][1]) if has_info_stale() else {}

    if need_ratings_fetch:
        _rate_limit_wait()
        try:
            fetched_ratings = _fetch_fields(indicator, _RATINGS_FIELDS)
            with _LIVE_STATS_CACHE_LOCK:
                _RATINGS_CACHE[ticker_key] = (now, fetched_ratings)
                _RATINGS_FAILURES.pop(ticker_key, None)
                ratings_data = dict(fetched_ratings)
        except Exception:
            with _LIVE_STATS_CACHE_LOCK:
                _RATINGS_FAILURES[ticker_key] = now
                ratings_data = dict(_RATINGS_CACHE[ticker_key][1]) if has_ratings_stale() else {}

    merged = {**info_data, **ratings_data, **history_data}
    return {k: v for k, v in merged.items() if v is not None or k == "pe_forward"}


def _derive_bucket_from_eval(ticker: str, eval_data: dict[str, Any]) -> str | None:
    return bucket_from_eval_json(ticker, eval_data)


def _build_row(
    pos: dict[str, Any],
    stats_cache: dict[str, Any],
    eval_cache: dict[str, Any],
) -> dict[str, Any]:
    ticker = pos.get("ticker")
    if not ticker:
        return {}

    cached = stats_cache.get(ticker, {})
    if not isinstance(cached, dict):
        cached = {}

    # Cache is a read-through fallback: keep non-market metadata always,
    # and use cached market fields only when live fetch fails or omits them.
    cached_meta: dict[str, Any] = {k: v for k, v in cached.items() if k not in _MARKET_KEYS}
    cached_market: dict[str, Any] = {k: v for k, v in cached.items() if k in _MARKET_KEYS}

    eval_data = eval_cache.get(ticker, {})
    if not isinstance(eval_data, dict):
        eval_data = {}

    cached_only = bool(pos.get("_cached_only"))
    live_market = {} if cached_only else _fetch_live_stats(ticker)

    # Start with metadata, then market (cached -> live overrides)
    stats: dict[str, Any] = {**cached_meta, **cached_market, **live_market}

    qty = float(pos.get("quantity") or 0)
    delta = float(pos.get("delta") if pos.get("delta") is not None else 0.0)
    price = stats.get("current_price") or stats.get("price")

    notional = calculate_notional(qty, delta, price) if qty and price else 0.0

    normalized_eval = normalize_eval_json(eval_data)
    fallback_eval = _indicator_eval_fallback(stats)

    overall, overall_from_llm = _pick_eval_value(
        eval_data=eval_data,
        normalized_eval=normalized_eval,
        fallback_eval=fallback_eval,
        key="overall",
        aliases=("score",),
    )
    quality, quality_from_llm = _pick_eval_value(
        eval_data=eval_data,
        normalized_eval=normalized_eval,
        fallback_eval=fallback_eval,
        key="quality",
    )
    valuation, valuation_from_llm = _pick_eval_value(
        eval_data=eval_data,
        normalized_eval=normalized_eval,
        fallback_eval=fallback_eval,
        key="valuation",
    )
    moat, moat_from_llm = _pick_eval_value(
        eval_data=eval_data,
        normalized_eval=normalized_eval,
        fallback_eval=fallback_eval,
        key="moat",
    )
    upside, upside_from_llm = _pick_eval_value(
        eval_data=eval_data,
        normalized_eval=normalized_eval,
        fallback_eval=fallback_eval,
        key="upside",
    )
    bull, bull_from_llm = _pick_eval_value(
        eval_data=eval_data,
        normalized_eval=normalized_eval,
        fallback_eval=fallback_eval,
        key="bull",
        aliases=("bull_probability",),
    )
    bear, bear_from_llm = _pick_eval_value(
        eval_data=eval_data,
        normalized_eval=normalized_eval,
        fallback_eval=fallback_eval,
        key="bear",
        aliases=("bear_probability",),
    )
    llm_flags = (
        overall_from_llm,
        quality_from_llm,
        valuation_from_llm,
        moat_from_llm,
        upside_from_llm,
        bull_from_llm,
        bear_from_llm,
    )
    llm_count = sum(1 for flag in llm_flags if flag)
    eval_source = "llm" if llm_count == len(llm_flags) else ("indicator_fallback" if llm_count == 0 else "hybrid")

    bucket = pos.get("bucket") or _derive_bucket_from_eval(ticker, eval_data) or stats.get("bucket")
    quote_type = str(stats.get("quote_type") or "").upper()
    equity_type = "ETF" if quote_type == "ETF" else ("STOCK" if quote_type else "UNKNOWN")
    etf_holdings = stats.get("etf_holdings") or stats.get("holdings") or []
    if not isinstance(etf_holdings, list):
        etf_holdings = []
    etf_holdings_fetched_at = stats.get("etf_holdings_fetched_at")
    if etf_holdings_fetched_at is not None:
        etf_holdings_fetched_at = str(etf_holdings_fetched_at)
    etf_holdings_update_tier = _UPDATE_TIER_ETF_HOLDINGS_LABEL if etf_holdings else None

    return {
        "overall": overall,
        "quality": quality,
        "valuation": valuation,
        "moat": moat,
        "upside": upside,
        "market_cap_score": normalized_eval.get("market_cap_score"),
        "bull": bull,
        "bear": bear,
        "eval_source": eval_source,
        "market_update_tier": _UPDATE_TIER_FAST_LABEL,
        "indicator_update_tier": _UPDATE_TIER_SLOW_LABEL,
        "ratings_update_tier": _UPDATE_TIER_RATINGS_LABEL,
        "evaluation_update_tier": _UPDATE_TIER_EVAL_LABEL,
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


def get_dashboard(
    portfolio_path: str | Path = "data/portfolio.json",
    stats_path: str | Path = "data/stats.json",
    eval_path: str | Path = "data/eval.json",
    include_cached_universe: bool = True,
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
            if isinstance(item, dict) and (t := item.get("ticker")):
                eval_data[str(t)] = item

    positions_raw = portfolio_data if isinstance(portfolio_data, list) else portfolio_data.get("positions", [])

    # Build row universe from portfolio + stats cache tickers.
    # This lets non-position tickers (qty=0) still receive live stat refreshes.
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

    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as executor:
        rows = list(
            executor.map(
                lambda p: _build_row(p, stats_data, eval_data),
                positions,
            )
        )

    total_notional = sum(row.get("notional", 0) for row in rows)
    for row in rows:
        notional = row.get("notional", 0)
        row["weight_pct"] = (notional / total_notional * 100) if total_notional > 0 else 0.0

    scored_rows: list[tuple[int, float]] = []
    for idx, row in enumerate(rows):
        overall = row.get("overall")
        if overall is None:
            continue
        try:
            scored_rows.append((idx, float(overall)))
        except (TypeError, ValueError):
            continue

    scored_rows.sort(key=lambda x: x[1], reverse=True)
    for rank, (idx, _) in enumerate(scored_rows, start=1):
        rows[idx]["rank"] = rank

    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.sort_values(by="weight_pct", ascending=False, na_position="last")

    return df


def _to_float(val: Any) -> float | None:
    if val is None:
        return None
    try:
        parsed = float(val)
        return parsed if parsed == parsed else None  # NaN check
    except (TypeError, ValueError):
        return None


def _fmt_pct(val: Any) -> str:
    if (parsed := _to_float(val)) is None:
        return "-"
    color = "green" if parsed >= 0 else "red"
    return f"[{color}]{parsed:.2f}%[/{color}]"


def _fmt_curr(val: Any) -> str:
    if (parsed := _to_float(val)) is None:
        return "-"
    return f"${parsed:,.2f}"


def _fmt_num(val: Any) -> str:
    if (parsed := _to_float(val)) is None:
        return "-"
    return f"{parsed:.2f}"


def display_dashboard(
    portfolio_path: str | Path = "data/portfolio.json",
    stats_path: str | Path = "data/stats.json",
) -> None:
    df = get_dashboard(portfolio_path, stats_path)

    console = Console()
    table = Table(title="Portfolio Dashboard", box=box.ROUNDED, header_style="bold magenta")

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

    for _, row in df.iterrows():
        table.add_row(
            str(row["ticker"]),
            str(row["quantity"]),
            _fmt_curr(row["current_price"]),
            _fmt_pct(row["change_percent"]),
            _fmt_num(row["rsi"]),
            _fmt_pct(row["one_month_change_percent"]),
            _fmt_pct(row["three_month_change_percent"]),
            _fmt_pct(row["six_month_change_percent"]),
            _fmt_pct(row["one_year_change_percent"]),
            _fmt_pct(row["median_upside"]),
            _fmt_curr(row["notional"]),
            _fmt_pct(row["weight_pct"]),
        )

    console.print(table)
