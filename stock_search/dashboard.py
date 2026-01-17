import json
from pathlib import Path

import pandas as pd
from rich import box
from rich.console import Console
from rich.table import Table

from stock_search.portfolio import calculate_notional


def _load_json(path: str | Path) -> list | dict:
    path = Path(path)
    if not path.exists():
        return []
    return json.loads(path.read_text())


def get_dashboard(portfolio_path: str | Path = "data/portfolio.json", stats_path: str | Path = "data/stats.json") -> pd.DataFrame:
    """Return a raw portfolio table as a DataFrame."""
    portfolio_data = _load_json(portfolio_path)
    stats_data = _load_json(stats_path)

    # Handle list vs dict format for portfolio (legacy vs new)
    positions = portfolio_data if isinstance(portfolio_data, list) else portfolio_data.get("positions", [])

    rows = []
    for pos in positions:
        ticker = pos.get("ticker")
        stats = stats_data.get(ticker, {})

        qty = float(pos.get("quantity") or 0)
        delta = float(pos.get("delta") or 1.0)
        price = stats.get("current_price")

        notional = None
        if qty and price:
            try:
                # Use helper if available or inline
                notional = calculate_notional(qty, delta, price)
            except Exception:
                notional = qty * price * delta

        row = {
            "ticker": ticker,
            "name": stats.get("name"),
            "quantity": qty,
            "delta": delta,
            "current_price": price,
            "change": None,  # Not strictly in stats.json yet unless added
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
            "bucket": stats.get("bucket"),
            "notional": notional,
            "weight_pct": None,
        }
        rows.append(row)

    total_notional = sum((row["notional"] or 0) for row in rows)
    if total_notional > 0:
        for row in rows:
            row["weight_pct"] = ((row["notional"] or 0) / total_notional) * 100
    else:
        for row in rows:
            row["weight_pct"] = None

    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.sort_values(by="weight_pct", ascending=False, na_position="last")
    return df


def display_dashboard(portfolio_path: str | Path = "data/portfolio.json", stats_path: str | Path = "data/stats.json") -> None:
    """Display the portfolio dashboard using Rich."""
    df = get_dashboard(portfolio_path, stats_path)

    console = Console()
    table = Table(title="Portfolio Dashboard", box=box.ROUNDED, header_style="bold magenta")

    # Define columns with specific formatting
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

        def to_float(val) -> float | None:
            if val is None:
                return None
            try:
                parsed = float(val)
            except (TypeError, ValueError):
                return None
            return None if parsed != parsed else parsed

        # Helper to format percentages with color
        def fmt_pct(val) -> str:
            if (parsed := to_float(val)) is None:
                return "-"
            color = "green" if parsed >= 0 else "red"
            return f"[{color}]{parsed:.2f}%[/{color}]"

        def fmt_curr(val) -> str:
            if (parsed := to_float(val)) is None:
                return "-"
            return f"${parsed:,.2f}"

        def fmt_num(val) -> str:
            if (parsed := to_float(val)) is None:
                return "-"
            return f"{parsed:.2f}"

        table.add_row(
            str(row["ticker"]),
            str(row["quantity"]),
            fmt_curr(row["current_price"]),
            fmt_pct(row["change_percent"]),
            fmt_num(row["rsi"]),
            fmt_pct(row["twenty_day_change_percent"]),
            fmt_pct(row["fifty_day_change_percent"]),
            fmt_pct(row["two_hundred_day_change_percent"]),
            fmt_num(row["median_upside"]),
            fmt_curr(row["notional"]),
            f"{row['weight_pct']:.2f}%",
        )

    console.print(table)


if __name__ == "__main__":
    display_dashboard()
