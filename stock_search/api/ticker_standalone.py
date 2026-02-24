from __future__ import annotations

import asyncio
import logging
from typing import Any, Literal

from fastapi import HTTPException

from stock_search.common_utils import normalize_ticker_symbol
from stock_search.indicators import StockIndicator

from .data_store import load_stats_map, load_stocks
from .portfolio_store import find_position_index, load_positions

logger = logging.getLogger(__name__)


def _normalize_labels(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    labels: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        label = item.strip()
        if not label or label in seen:
            continue
        seen.add(label)
        labels.append(label)
    return labels


def _load_cached_ticker_stats(ticker: str) -> dict[str, Any]:
    stats_data = load_stats_map()
    cached = stats_data.get(normalize_ticker_symbol(ticker))
    return cached if isinstance(cached, dict) else {}


def _load_cached_stock_labels(ticker: str) -> list[str]:
    stocks_map = load_stocks()
    stock_row = stocks_map.get(normalize_ticker_symbol(ticker))
    if not isinstance(stock_row, dict):
        return []
    return _normalize_labels(stock_row.get("labels"))


def _load_live_ticker_stats(ticker: str, cached_row: dict[str, Any]) -> dict[str, Any]:
    return StockIndicator(ticker, cached_row=cached_row).get_all_indicators()


async def resolve_standalone_ticker_stats(
    ticker: str,
    *,
    source: Literal["auto", "live", "cache"],
) -> tuple[dict[str, Any], str]:
    ticker_upper = normalize_ticker_symbol(ticker)
    if not ticker_upper:
        raise HTTPException(status_code=400, detail=f"Invalid ticker: {ticker}")
    positions = await asyncio.to_thread(load_positions)
    cached = await asyncio.to_thread(_load_cached_ticker_stats, ticker_upper)
    cached_labels = await asyncio.to_thread(_load_cached_stock_labels, ticker_upper)
    idx = find_position_index(positions, ticker_upper)
    position = (
        positions[idx]
        if idx is not None
        else {
            "ticker": ticker_upper,
            "quantity": 0.0,
            "strategy": None,
        }
    )
    base = {
        "ticker": ticker_upper,
        "quantity": float(position.get("quantity") or 0.0),
        "strategy": position.get("strategy"),
        "industry_labels": cached_labels,
        "primary_label": cached_labels[0] if cached_labels else None,
    }

    if source == "cache":
        row = {**base, **cached}
        return row, "cache"

    try:
        live = await asyncio.to_thread(_load_live_ticker_stats, ticker_upper, cached)
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
