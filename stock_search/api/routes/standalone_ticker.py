"""Serve standalone ticker API routes."""

from typing import Literal

from fastapi import APIRouter, Response

from stock_search.api.data_store import backend_name
from stock_search.api.meta import now_iso
from stock_search.api.route_paths import STOCK_STATS
from stock_search.api.ticker_standalone import resolve_standalone_ticker_stats

router = APIRouter()


@router.get(STOCK_STATS)
async def stock_ticker_stats_api(
    ticker: str,
    response: Response,
    source: Literal["auto", "live", "cache"] = "auto",
) -> dict:
    """Serve stock ticker stats."""
    response.headers["Cache-Control"] = "no-store"
    row, data_source = await resolve_standalone_ticker_stats(ticker, source=source)
    return {
        "row": row,
        "meta": {
            "generated_at": now_iso(),
            "data_source": data_source,
            "backend_store": backend_name(),
            "sync_mode": "realtime_subscription",
        },
    }
