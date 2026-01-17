from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from typing import Any

import pandas as pd
from rich import box
from rich.console import Console
from rich.table import Table

from stock_search.indicators import StockIndicator
from stock_search.portfolio import calculate_notional


def _load_json(path: str | Path) -> Any:
    """Safely load JSON data from a file."""
    path = Path(path)
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def _fetch_live_stats(ticker: str) -> dict[str, Any]:
    """Fetch live statistics for a ticker using StockIndicator."""
    try:
        indicator = StockIndicator(ticker)
        data = indicator.get_all_indicators()

        # Add name which isn't in standard indicators
        info = indicator.info
        data["name"] = info.get("shortName") or info.get("longName")

        # Map 'price' to 'current_price' for compatibility with dashboard schema
        data["current_price"] = data.get("price")

        # Filter out None values to allow cleaner merging with cache
        return {k: v for k, v in data.items() if v is not None}
    except Exception:
        return {}


def _build_row(pos: dict, stats_cache: dict) -> dict:
    """Build a single dashboard row by merging cached and live data."""
    ticker = pos.get("ticker")
    if not ticker:
        return {}

    # 1. Start with cached data
    stats = stats_cache.get(ticker, {}).copy()

    # 2. Fetch live data
    live_stats = _fetch_live_stats(ticker)

    # 3. Update cache with live data (live takes precedence)
    stats.update(live_stats)

    # 4. Calculate Position Metrics
    qty = float(pos.get("quantity") or 0)
    delta = float(pos.get("delta") or 1.0)
    price = stats.get("current_price")

    notional = 0.0
    if qty and price:
        try:
            notional = calculate_notional(qty, delta, price)
        except Exception:
            notional = qty * price * delta

    # 5. Construct Row
    return {
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
        "earning_direction": stats.get("earning_direction"),
        "gross_margin": stats.get("gross_margin"),
        "rsi": stats.get("rsi"),
        "twenty_day_change_percent": stats.get("twenty_day_change_percent"),
        "fifty_day_change_percent": stats.get("fifty_day_change_percent"),
        "one_hundred_day_change_percent": stats.get("one_hundred_day_change_percent"),
        "two_hundred_day_change_percent": stats.get("two_hundred_day_change_percent"),
        "median_upside": stats.get("median_upside"),
        # Bucket can come from cache (stats.json) or portfolio input
        "bucket": stats.get("bucket") or pos.get("bucket"),
        "notional": notional,
        "weight_pct": None,  # Calculated in aggregation step
    }


def get_dashboard(portfolio_path: str | Path = "data/portfolio.json", stats_path: str | Path = "data/stats.json") -> pd.DataFrame:
    """Return a consolidated portfolio DataFrame with live market data."""
    portfolio_data = _load_json(portfolio_path)

    # Load stats cache; ensure it's a dict
    stats_data = _load_json(stats_path)
    if not isinstance(stats_data, dict):
        stats_data = {}

    # Handle portfolio list vs dict wrapper
    positions = portfolio_data if isinstance(portfolio_data, list) else portfolio_data.get("positions", [])

    # Parallelize fetching and row building
    with ThreadPoolExecutor() as executor:
        rows = list(executor.map(lambda p: _build_row(p, stats_data), positions))

    # Calculate Weights
    total_notional = sum(row.get("notional", 0) for row in rows)
    for row in rows:
        notional = row.get("notional", 0)
        row["weight_pct"] = (notional / total_notional * 100) if total_notional > 0 else 0.0

    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.sort_values(by="weight_pct", ascending=False, na_position="last")

    return df


def _to_float(val: Any) -> float | None:
    if val is None:
        return None
    try:
        parsed = float(val)
        return parsed if parsed == parsed else None  # Check for NaN
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


def display_dashboard(portfolio_path: str | Path = "data/portfolio.json", stats_path: str | Path = "data/stats.json") -> None:
    """Display the portfolio dashboard using Rich."""
    df = get_dashboard(portfolio_path, stats_path)

    console = Console()
    table = Table(title="Portfolio Dashboard", box=box.ROUNDED, header_style="bold magenta")

    # Define columns
    table.add_column("Ticker", style="cyan", no_wrap=True)
    table.add_column("Qty", justify="right")
    table.add_column("Price", justify="right")
    table.add_column("Change %", justify="right")
    table.add_column("RSI", justify="right")
    table.add_column("20d %", justify="right")
    table.add_column("50d %", justify="right")
    table.add_column("200d %", justify="right")
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
            _fmt_pct(row["twenty_day_change_percent"]),
            _fmt_pct(row["fifty_day_change_percent"]),
            _fmt_pct(row["two_hundred_day_change_percent"]),
            _fmt_num(row["median_upside"]),
            _fmt_curr(row["notional"]),
            f"{row['weight_pct']:.2f}%" if row["weight_pct"] is not None else "-",
        )

    console.print(table)


if __name__ == "__main__":
    display_dashboard()
