from __future__ import annotations

from typing import Any

from stock_search.file_utils import load_json, write_json

from .config import PORTFOLIO_PATH


def load_positions() -> list[dict[str, Any]]:
    portfolio_data = load_json(PORTFOLIO_PATH, default=[])
    if isinstance(portfolio_data, list):
        return [row for row in portfolio_data if isinstance(row, dict)]
    if isinstance(portfolio_data, dict):
        positions = portfolio_data.get("positions", [])
        if isinstance(positions, list):
            return [row for row in positions if isinstance(row, dict)]
    return []


def save_positions(positions: list[dict[str, Any]]) -> None:
    write_json(PORTFOLIO_PATH, {"positions": positions})


def find_position_index(positions: list[dict[str, Any]], ticker: str) -> int | None:
    ticker_upper = ticker.upper()
    return next(
        (index for index, position in enumerate(positions) if str(position.get("ticker", "")).upper() == ticker_upper),
        None,
    )
