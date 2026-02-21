from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import HTTPException

from stock_search.file_utils import load_json
from stock_search.portfolio import fetch_live_stats_async, normalize_labels, resolve_portfolio_labels

from .config import STATS_PATH
from .portfolio_store import find_position_index, load_positions

logger = logging.getLogger(__name__)


def _load_cached_ticker_stats(ticker: str) -> dict[str, Any]:
    stats_data = load_json(STATS_PATH, default={})
    if not isinstance(stats_data, dict):
        return {}
    cached = stats_data.get(ticker.upper())
    return cached if isinstance(cached, dict) else {}


async def resolve_standalone_ticker_stats(
    ticker: str,
    *,
    source: Literal["auto", "live", "cache"],
) -> tuple[dict[str, Any], str]:
    ticker_upper = ticker.upper().strip()
    positions = load_positions()
    labels_by_ticker = resolve_portfolio_labels(positions, fetch_missing=(source != "cache"))
    cached = _load_cached_ticker_stats(ticker_upper)
    idx = find_position_index(positions, ticker_upper)
    position = positions[idx] if idx is not None else {"ticker": ticker_upper, "quantity": 0.0, "strategy": None, "industry_labels": []}
    industry_labels = normalize_labels(labels_by_ticker.get(ticker_upper, position.get("industry_labels")))
    base = {
        "ticker": ticker_upper,
        "quantity": float(position.get("quantity") or 0.0),
        "strategy": position.get("strategy"),
        "industry_labels": industry_labels,
        "primary_label": industry_labels[0] if industry_labels else None,
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
