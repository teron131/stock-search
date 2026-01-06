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


def _get_indicator(position: PortfolioPosition) -> StockIndicator | None:
    """Return a StockIndicator instance or None if unavailable."""
    try:
        return StockIndicator(position.ticker)
    except Exception:
        return None


def _resolve_price(position: PortfolioPosition, indicator: StockIndicator | None) -> float | None:
    """Return current price from indicators, falling back to stored price."""
    if indicator is None:
        return position.current_price
    return indicator.price or position.current_price


def _row_for_position(position: PortfolioPosition, total_notional: float | None) -> dict:
    """Build a raw row for the dashboard table."""
    indicator = _get_indicator(position)
    current_price = _resolve_price(position, indicator)
    notional = None
    weight_pct = None
    if position.quantity is not None and position.delta is not None and current_price is not None:
        notional = calculate_notional(position.quantity, position.delta, current_price)
        if total_notional:
            weight_pct = (notional / total_notional) * 100

    return {
        "ticker": position.ticker,
        "quantity": position.quantity,
        "delta": position.delta,
        "current_price": current_price,
        "change": indicator.change if indicator else None,
        "change_percent": indicator.change_percent if indicator else None,
        "peg": indicator.peg if indicator else None,
        "earning_direction": indicator.earning_direction if indicator else None,
        "rsi": indicator.rsi if indicator else None,
        "twenty_day_change_percent": indicator.twenty_day_change_percent if indicator else None,
        "fifty_day_change_percent": indicator.fifty_day_change_percent if indicator else None,
        "one_hundred_day_change_percent": indicator.one_hundred_day_change_percent if indicator else None,
        "two_hundred_day_change_percent": indicator.two_hundred_day_change_percent if indicator else None,
        "median_upside": indicator.median_upside if indicator else None,
        "bucket": position.bucket,
        "notional": notional,
        "weight_pct": weight_pct,
    }


def get_dashboard(portfolio_path: str | Path = "portfolio.json") -> pd.DataFrame:
    """Return a raw portfolio table as a DataFrame."""
    portfolio = _load_portfolio(portfolio_path)
    notionals = []
    for position in portfolio.positions:
        indicator = _get_indicator(position)
        current_price = _resolve_price(position, indicator)
        if position.quantity is None or position.delta is None or current_price is None:
            continue
        notionals.append(calculate_notional(position.quantity, position.delta, current_price))
    total_notional = sum(notionals) if notionals else None
    rows = [_row_for_position(position, total_notional) for position in portfolio.positions]
    df = pd.DataFrame(rows)
    if "weight_pct" in df.columns:
        df = df.sort_values(by="weight_pct", ascending=False, na_position="last")
    return df
