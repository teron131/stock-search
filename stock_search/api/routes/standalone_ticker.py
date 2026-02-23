from typing import Literal

from fastapi import APIRouter, Response

from stock_search.api.data_store import backend_name
from stock_search.api.meta import now_iso
from stock_search.api.ticker_standalone import resolve_standalone_ticker_stats

router = APIRouter()


@router.get("/api/portfolio/{ticker}")
async def portfolio_ticker_api(
    ticker: str,
    response: Response,
    source: Literal["auto", "live", "cache"] = "auto",
) -> dict:
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


@router.get("/api/stats/{ticker}")
async def ticker_stats_api(
    ticker: str,
    response: Response,
    source: Literal["auto", "live", "cache"] = "auto",
) -> dict:
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
