from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path

import pandas as pd

from stock_search.indicators import StockIndicator
from stock_search.portfolio import calculate_notional
from stock_search.schema import Portfolio, PortfolioPosition


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
