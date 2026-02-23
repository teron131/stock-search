from __future__ import annotations

from typing import Any

from .data_store import load_positions as _load_positions, save_positions as _save_positions


def load_positions() -> list[dict[str, Any]]:
    return _load_positions()


def save_positions(positions: list[dict[str, Any]]) -> None:
    _save_positions(positions)


def find_position_index(positions: list[dict[str, Any]], ticker: str) -> int | None:
    ticker_upper = ticker.upper()
    return next(
        (index for index, position in enumerate(positions) if str(position.get("ticker", "")).upper() == ticker_upper),
        None,
    )
