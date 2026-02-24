from __future__ import annotations

import logging
import os
from pathlib import Path
import tempfile
from time import perf_counter
from typing import Any

from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from llm_harness.clients import ImageAnalysisAgent
from pydantic import BaseModel, Field

from stock_search.api.config import EVAL_PATH, PORTFOLIO_PATH, STATS_PATH
from stock_search.api.data_store import backend_name
from stock_search.api.meta import now_iso, stats_cache_generated_at
from stock_search.api.portfolio_store import find_position_index, load_positions, save_positions
from stock_search.api.route_paths import PORTFOLIO, PORTFOLIO_IMPORT_IMAGE, PORTFOLIO_TICKER
from stock_search.indicators import StockIndicator
from stock_search.models import PortfolioPositionInput
from stock_search.portfolio import get_portfolio_payload_async

logger = logging.getLogger(__name__)
router = APIRouter()

PORTFOLIO_SCOPE_CONFIG = {
    "priority": {
        "include_cached_universe": False,
        "include_live_market": False,
        "use_cache_timestamp": True,
    },
    "portfolio_live": {
        "include_cached_universe": False,
        "include_live_market": True,
        "use_cache_timestamp": False,
    },
    "all": {
        "include_cached_universe": True,
        "include_live_market": True,
        "use_cache_timestamp": False,
    },
}

PORTFOLIO_DATA_SOURCE = {
    "priority": "cache",
    "portfolio_live": "live_with_cache_fallback",
    "all": "live_with_cache_fallback",
}


class PortfolioPositionPatch(BaseModel):
    quantity: float | None = None
    strategy: str | None = None


class StoredPortfolioPosition(PortfolioPositionInput):
    strategy: str | None = None

    def to_storage_dict(self) -> dict[str, Any]:
        payload = self.model_dump(exclude_none=True)
        payload["ticker"] = self.ticker.upper()
        return payload


class PortfolioLineItem(BaseModel):
    ticker: str
    quantity: float


class PortfolioImageExtraction(BaseModel):
    holdings: list[PortfolioLineItem] = Field(default_factory=list)


def _ensure_valid_new_ticker(ticker: str) -> None:
    indicator = StockIndicator(ticker)
    if indicator.price is None:
        raise HTTPException(status_code=400, detail=f"Invalid ticker: {ticker}")


def _extract_holdings_from_image_bytes(
    image_bytes: bytes,
    *,
    image_filename: str,
    model_override: str | None = None,
) -> PortfolioImageExtraction:
    model = model_override or os.getenv("FAST_LLM") or os.getenv("QUALITY_LLM")
    if not model:
        raise HTTPException(status_code=500, detail="No model configured for image extraction.")

    suffix = Path(image_filename).suffix or ".jpg"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp_file:
        tmp_file.write(image_bytes)
        temp_path = Path(tmp_file.name)

    try:
        agent = ImageAnalysisAgent(
            model=model,
            response_format=PortfolioImageExtraction,
            temperature=0,
            system_prompt="You extract portfolio holdings from screenshots. Return only ticker/quantity pairs that are clearly visible.",
        )
        prompt = (
            "Read this portfolio image and extract holdings.\n"
            "Rules:\n"
            "1. Keep ticker uppercase.\n"
            "2. Quantity must be numeric.\n"
            "3. Skip rows if ticker or quantity is unreadable.\n"
            "4. Return only holdings."
        )
        result = agent.invoke(image_paths=temp_path, description=prompt)
        if not isinstance(result, PortfolioImageExtraction):
            raise HTTPException(status_code=502, detail="Unexpected response from image extraction model.")
        return result
    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed portfolio image extraction.")
        raise HTTPException(status_code=502, detail="Failed to extract holdings from image.") from None
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            logger.warning("Failed to delete temp image file: %s", temp_path)


@router.get(PORTFOLIO)
async def portfolio_api(response: Response, scope: str = "all") -> dict:
    response.headers["Cache-Control"] = "no-store"
    started_at = perf_counter()

    resolved_scope = scope if scope in PORTFOLIO_SCOPE_CONFIG else "all"
    scope_config = PORTFOLIO_SCOPE_CONFIG[resolved_scope]
    include_cached_universe = scope_config["include_cached_universe"]
    include_live_market = scope_config["include_live_market"]

    payload = await get_portfolio_payload_async(
        PORTFOLIO_PATH,
        STATS_PATH,
        EVAL_PATH,
        include_cached_universe=include_cached_universe,
        include_live_market=include_live_market,
    )
    generated_at = stats_cache_generated_at(STATS_PATH) if scope_config["use_cache_timestamp"] else now_iso()
    payload["meta"]["generated_at"] = generated_at
    payload["meta"]["data_source"] = PORTFOLIO_DATA_SOURCE[resolved_scope]
    payload["meta"]["backend_store"] = backend_name()
    payload["meta"]["sync_mode"] = "realtime_subscription"
    elapsed_ms = (perf_counter() - started_at) * 1000
    logger.info(
        "portfolio_api scope=%s rows=%s live=%s cached_universe=%s duration_ms=%.1f",
        resolved_scope,
        len(payload["rows"]),
        include_live_market,
        include_cached_universe,
        elapsed_ms,
    )
    return payload


@router.patch(PORTFOLIO_TICKER)
def patch_position(ticker: str, patch: PortfolioPositionPatch):
    ticker_upper = ticker.upper()
    positions = load_positions()
    idx = find_position_index(positions, ticker_upper)

    if idx is None:
        if patch.quantity is None and patch.strategy is None:
            raise HTTPException(status_code=400, detail="Patch payload is empty.")
        _ensure_valid_new_ticker(ticker_upper)
        current = StoredPortfolioPosition(ticker=ticker_upper).to_storage_dict()
        positions.append(current)
        idx = len(positions) - 1
    else:
        current = dict(positions[idx])

    if patch.quantity is not None:
        current["quantity"] = patch.quantity

    if patch.strategy is not None:
        if patch.strategy == "":
            current.pop("strategy", None)
        else:
            current["strategy"] = patch.strategy

    positions[idx] = StoredPortfolioPosition.model_validate(current).to_storage_dict()
    save_positions(positions)
    return {"status": "ok", "ticker": ticker_upper, "position": positions[idx]}


@router.delete(PORTFOLIO_TICKER)
def remove_position(ticker: str):
    ticker_upper = ticker.upper()
    positions = [position for position in load_positions() if position.get("ticker", "").upper() != ticker_upper]
    save_positions(positions)
    return {"status": "ok", "ticker": ticker_upper}


@router.post(PORTFOLIO_IMPORT_IMAGE)
async def import_portfolio_image_api(
    response: Response,
    file: UploadFile = File(...),
    replace: bool = True,
    strategy: str | None = None,
    model: str | None = None,
) -> dict:
    response.headers["Cache-Control"] = "no-store"

    if not file.filename:
        raise HTTPException(status_code=400, detail="Image filename is required.")
    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be an image.")

    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Uploaded image is empty.")

    extraction = _extract_holdings_from_image_bytes(
        image_bytes,
        image_filename=file.filename,
        model_override=model,
    )
    positions = [] if replace else load_positions()
    position_index = {str(position.get("ticker", "")).upper(): idx for idx, position in enumerate(positions)}
    applied: list[dict[str, Any]] = []

    for item in extraction.holdings:
        ticker = str(item.ticker).upper().strip()
        quantity = float(item.quantity)
        if not ticker or quantity <= 0:
            continue

        payload: dict[str, Any] = {"ticker": ticker, "quantity": quantity}
        if strategy:
            payload["strategy"] = strategy

        validated = StoredPortfolioPosition.model_validate(payload).to_storage_dict()
        if ticker in position_index:
            existing = dict(positions[position_index[ticker]])
            existing["quantity"] = quantity
            if strategy:
                existing["strategy"] = strategy
            positions[position_index[ticker]] = StoredPortfolioPosition.model_validate(existing).to_storage_dict()
        else:
            positions.append(validated)
            position_index[ticker] = len(positions) - 1

        applied.append({"ticker": ticker, "quantity": quantity})

    save_positions(positions)
    return {
        "status": "ok",
        "applied_count": len(applied),
        "applied": applied,
        "replace": replace,
    }
