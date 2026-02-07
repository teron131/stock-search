from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pandas as pd
from rich import box
from rich.console import Console
from rich.table import Table

from stock_search.evaluation.evaluation import (
    bucket_from_eval_json,
    normalize_eval_json,
)
from stock_search.file_utils import load_json
from stock_search.indicators import StockIndicator
from stock_search.portfolio import calculate_notional

_MAX_WORKERS = 10

_MARKET_KEYS = {
    "price",
    "current_price",
    "change",
    "change_percent",
    "market_cap",
    "pe",
    "pe_forward",
    "peg",
    "debt_to_equity",
    "free_cash_flow",
    "revenue_growth",
    "earning_direction",
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


def _fetch_live_stats(ticker: str) -> dict[str, Any]:
    """Fetch live-ish market stats for a ticker.

    This intentionally does not fall back to `stats.json` for market fields.
    """
    try:
        indicator = StockIndicator(ticker)
        data = indicator.get_all_indicators()

        info = indicator.info
        data["name"] = info.get("shortName") or info.get("longName")
        data["current_price"] = data.get("price")

        return {k: v for k, v in data.items() if v is not None}
    except Exception:
        return {}


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

    live_market = _fetch_live_stats(ticker)

    # Start with metadata, then market (cached -> live overrides)
    stats: dict[str, Any] = {**cached_meta, **cached_market, **live_market}

    qty = float(pos.get("quantity") or 0)
    delta = float(pos.get("delta") if pos.get("delta") is not None else 0.0)
    price = stats.get("current_price") or stats.get("price")

    notional = calculate_notional(qty, delta, price) if qty and price else 0.0

    normalized_eval = normalize_eval_json(eval_data)

    bucket = pos.get("bucket") or _derive_bucket_from_eval(ticker, eval_data) or stats.get("bucket")

    return {
        "overall": normalized_eval.get("overall"),
        "quality": normalized_eval.get("quality"),
        "valuation": normalized_eval.get("valuation"),
        "moat": normalized_eval.get("moat"),
        "upside": normalized_eval.get("upside"),
        "market_cap_score": normalized_eval.get("market_cap_score"),
        "bull": normalized_eval.get("bull"),
        "bear": normalized_eval.get("bear"),
        "rank": None,
        "ticker": ticker,
        "name": stats.get("name"),
        "quantity": qty,
        "delta": delta,
        "current_price": price,
        "change": stats.get("change"),
        "change_percent": stats.get("change_percent"),
        "market_cap": stats.get("market_cap"),
        "pe": stats.get("pe"),
        "pe_forward": stats.get("pe_forward"),
        "peg": stats.get("peg"),
        "debt_to_equity": stats.get("debt_to_equity"),
        "free_cash_flow": stats.get("free_cash_flow"),
        "revenue_growth": stats.get("revenue_growth"),
        "earning_direction": stats.get("earning_direction"),
        "gross_margin": stats.get("gross_margin"),
        "rsi": stats.get("rsi"),
        "one_month_change_percent": stats.get("one_month_change_percent"),
        "three_month_change_percent": stats.get("three_month_change_percent"),
        "six_month_change_percent": stats.get("six_month_change_percent"),
        "one_year_change_percent": stats.get("one_year_change_percent"),
        "median_upside": stats.get("median_upside"),
        "bucket": bucket,
        "notional": notional,
        "weight_pct": None,
    }


def get_dashboard(
    portfolio_path: str | Path = "data/portfolio.json",
    stats_path: str | Path = "data/stats.json",
    eval_path: str | Path = "data/eval.json",
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

    positions = portfolio_data if isinstance(portfolio_data, list) else portfolio_data.get("positions", [])

    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as executor:
        rows = list(executor.map(lambda p: _build_row(p, stats_data, eval_data), positions))

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
