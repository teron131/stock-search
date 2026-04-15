"""Resolve ticker stats outside the portfolio dashboard flow."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Literal

from fastapi import HTTPException

from stock_search.common_utils import normalize_ticker_symbol
from stock_search.stats_resolver import resolve_ticker_stats_async

from .data_store import load_ticker_context
from .portfolio_store import find_position_index

logger = logging.getLogger(__name__)


async def resolve_standalone_ticker_stats(
    ticker: str,
    *,
    source: Literal["auto", "live", "cache"],
) -> tuple[dict[str, Any], str]:
    """Resolve standalone ticker stats using live data with cache fallback."""
    ticker_upper = normalize_ticker_symbol(ticker)
    if not ticker_upper:
        raise HTTPException(status_code=400, detail=f"Invalid ticker: {ticker}")
    positions, cached, cached_labels = await asyncio.to_thread(load_ticker_context, ticker_upper)

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
        resolved = await resolve_ticker_stats_async(
            ticker_upper,
            mode=source,
            persisted_row=cached,
        )
    except Exception:
        logger.exception("Failed live stats fetch for %s", ticker_upper)
        if source == "live":
            raise HTTPException(status_code=502, detail=f"Live stats unavailable for ticker: {ticker_upper}") from None
        row = {**base, **cached}
        return row, "cache"

    row = {**base, **cached, **resolved.row}
    return row, resolved.data_source
