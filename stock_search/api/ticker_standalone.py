from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import HTTPException

from stock_search.file_utils import load_json
from stock_search.portfolio import fetch_live_stats_async

from .config import PORTFOLIO_PATH, STATS_PATH

logger = logging.getLogger(__name__)


def _load_positions() -> list[dict[str, Any]]:
    portfolio_data = load_json(PORTFOLIO_PATH, default=[])
    return portfolio_data if isinstance(portfolio_data, list) else []


def _load_cached_ticker_stats(ticker: str) -> dict[str, Any]:
    stats_data = load_json(STATS_PATH, default={})
    if not isinstance(stats_data, dict):
        return {}
    cached = stats_data.get(ticker.upper())
    return cached if isinstance(cached, dict) else {}


def _load_portfolio_position(ticker: str) -> dict[str, Any]:
    ticker_upper = ticker.upper()
    for position in _load_positions():
        if str(position.get("ticker", "")).upper() == ticker_upper:
            return position
    return {"ticker": ticker_upper, "quantity": 0.0, "strategy": None}


async def resolve_standalone_ticker_stats(
    ticker: str,
    *,
    source: Literal["auto", "live", "cache"],
) -> tuple[dict[str, Any], str]:
    ticker_upper = ticker.upper().strip()
    cached = _load_cached_ticker_stats(ticker_upper)
    position = _load_portfolio_position(ticker_upper)
    base = {
        "ticker": ticker_upper,
        "quantity": float(position.get("quantity") or 0.0),
        "strategy": position.get("strategy"),
    }

    if source == "cache":
        row = {**base, **cached}
        return row, "cache"

    try:
        live = await fetch_live_stats_async(ticker_upper)
    except Exception:
        logger.exception("Failed live stats fetch for %s", ticker_upper)
        if source == "live":
            raise HTTPException(status_code=502, detail=f"Live stats unavailable for ticker: {ticker_upper}") from None
        row = {**base, **cached}
        return row, "cache"

    row = {**base, **cached, **live}
    if source == "live":
        return row, "live"
    return row, "live_with_cache_fallback"
