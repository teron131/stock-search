from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path

import pandas as pd
from rich import box
from rich.console import Console
from rich.table import Table

from stock_search.indicators import StockIndicator
from stock_search.portfolio import calculate_notional
from stock_search.schemas import Portfolio, PortfolioPosition


def _load_portfolio(path: str | Path) -> Portfolio:
    """Load portfolio data from a JSON file."""
    data = json.loads(Path(path).read_text())
    return Portfolio.model_validate(data)


def _build_row(position: PortfolioPosition) -> dict:
    indicator = StockIndicator(position.ticker)
    current_price = indicator.price or position.current_price
    notional = calculate_notional(position.quantity, position.delta, current_price)

    return {
        "ticker": position.ticker,
        "name": position.name,
        "quantity": position.quantity,
        "delta": position.delta,
        "current_price": current_price,
        "change": indicator.change,
        "change_percent": indicator.change_percent,
        "peg": indicator.peg,
        "earning_direction": indicator.earning_direction,
        "rsi": indicator.rsi,
        "twenty_day_change_percent": indicator.twenty_day_change_percent,
        "fifty_day_change_percent": indicator.fifty_day_change_percent,
        "one_hundred_day_change_percent": indicator.one_hundred_day_change_percent,
        "two_hundred_day_change_percent": indicator.two_hundred_day_change_percent,
        "median_upside": indicator.median_upside,
        "bucket": position.bucket,
        "notional": notional,
        "weight_pct": None,
    }


def get_dashboard(portfolio_path: str | Path = "portfolio.json") -> pd.DataFrame:
    """Return a raw portfolio table as a DataFrame."""
    portfolio = _load_portfolio(portfolio_path)
    with ThreadPoolExecutor() as executor:
        rows = list(executor.map(_build_row, portfolio.positions))

    total_notional = sum(row["notional"] for row in rows)
    for row in rows:
        row["weight_pct"] = (row["notional"] / total_notional) * 100
    df = pd.DataFrame(rows)
    df = df.sort_values(by="weight_pct", ascending=False, na_position="last")
    return df


def display_dashboard(portfolio_path: str | Path = "portfolio.json") -> None:
    """Display the portfolio dashboard using Rich."""
    df = get_dashboard(portfolio_path)

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
        # Helper to format percentages with color
        def fmt_pct(val):
            if pd.isna(val):
                return "-"
            color = "green" if val >= 0 else "red"
            return f"[{color}]{val:.2f}%[/{color}]"

        # Helper to format currency
        def fmt_curr(val):
            if pd.isna(val):
                return "-"
            return f"${val:,.2f}"

        table.add_row(
            str(row["ticker"]),
            str(row["quantity"]),
            fmt_curr(row["current_price"]),
            fmt_pct(row["change_percent"]),
            f"{row['rsi']:.2f}" if pd.notna(row["rsi"]) else "-",
            fmt_pct(row["twenty_day_change_percent"]),
            fmt_pct(row["fifty_day_change_percent"]),
            fmt_pct(row["two_hundred_day_change_percent"]),
            f"{row['median_upside']:.2f}" if pd.notna(row["median_upside"]) else "-",
            fmt_curr(row["notional"]),
            f"{row['weight_pct']:.2f}%",
        )

    console.print(table)


if __name__ == "__main__":
    display_dashboard()
