from __future__ import annotations

from datetime import UTC, datetime
import logging
import os
from pathlib import Path
import tempfile
from time import perf_counter
from typing import Any, Literal

from fastapi import FastAPI, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from llm_harness.clients import ImageAnalysisAgent
from pydantic import BaseModel, Field

from stock_search.evaluation.constants import CalibrationConfig, MarketCapConfig
from stock_search.file_utils import load_json, write_json
from stock_search.indicators import StockIndicator
from stock_search.portfolio import fetch_live_stats_async, get_portfolio_payload_async
from stock_search.schemas import PortfolioPositionInput

BASE_DIR = Path(__file__).resolve().parents[1]
UI_DIR = BASE_DIR.parent / "ui"
INDEX_FILE = UI_DIR / "index.html"
DATA_DIR = BASE_DIR.parent / "data"
PORTFOLIO_PATH = DATA_DIR / "portfolio.json"
STATS_PATH = DATA_DIR / "stats.json"
EVAL_PATH = DATA_DIR / "eval.json"

app = FastAPI(title="Stock Search Dashboard")
logger = logging.getLogger(__name__)

_PORTFOLIO_SCOPE_CONFIG = {
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

_PORTFOLIO_DATA_SOURCE = {
    "priority": "cache",
    "portfolio_live": "live_with_cache_fallback",
    "all": "live_with_cache_fallback",
}

# Expose backend `data/` to the UI (portfolio/eval/stats JSON)
# This must be mounted before the UI mount at "/".
app.mount("/data", StaticFiles(directory=DATA_DIR), name="data")


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(INDEX_FILE)


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


def _stats_cache_generated_at() -> str | None:
    """Return `data/stats.json` mtime as ISO timestamp when available."""
    if not STATS_PATH.exists():
        return None
    modified_at = datetime.fromtimestamp(STATS_PATH.stat().st_mtime, tz=UTC)
    return modified_at.isoformat()


def _load_positions() -> list[dict[str, Any]]:
    portfolio_data = load_json(PORTFOLIO_PATH, default=[])
    return portfolio_data if isinstance(portfolio_data, list) else []


def _save_positions(positions: list[dict[str, Any]]) -> None:
    write_json(PORTFOLIO_PATH, positions)


def _ensure_valid_new_ticker(ticker: str) -> None:
    indicator = StockIndicator(ticker)
    if indicator.price is None:
        raise HTTPException(status_code=400, detail=f"Invalid ticker: {ticker}")


def _find_position_index(positions: list[dict[str, Any]], ticker: str) -> int | None:
    ticker_upper = ticker.upper()
    return next(
        (index for index, position in enumerate(positions) if position.get("ticker", "").upper() == ticker_upper),
        None,
    )


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


async def _resolve_ticker_stats(
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


@app.get("/api/portfolio")
async def portfolio_api(response: Response, scope: str = "all") -> dict:
    response.headers["Cache-Control"] = "no-store"
    started_at = perf_counter()

    resolved_scope = scope if scope in _PORTFOLIO_SCOPE_CONFIG else "all"
    scope_config = _PORTFOLIO_SCOPE_CONFIG[resolved_scope]
    include_cached_universe = scope_config["include_cached_universe"]
    include_live_market = scope_config["include_live_market"]

    payload = await get_portfolio_payload_async(
        PORTFOLIO_PATH,
        STATS_PATH,
        EVAL_PATH,
        include_cached_universe=include_cached_universe,
        include_live_market=include_live_market,
    )
    generated_at = _stats_cache_generated_at() if scope_config["use_cache_timestamp"] else datetime.now(tz=UTC).isoformat()
    payload["meta"]["generated_at"] = generated_at
    payload["meta"]["data_source"] = _PORTFOLIO_DATA_SOURCE[resolved_scope]
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


@app.get("/api/portfolio/{ticker}")
async def portfolio_ticker_api(
    ticker: str,
    response: Response,
    source: Literal["auto", "live", "cache"] = "auto",
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    row, data_source = await _resolve_ticker_stats(ticker, source=source)
    return {
        "row": row,
        "meta": {
            "generated_at": datetime.now(tz=UTC).isoformat(),
            "data_source": data_source,
        },
    }


@app.get("/api/stats/{ticker}")
async def ticker_stats_api(
    ticker: str,
    response: Response,
    source: Literal["auto", "live", "cache"] = "auto",
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    row, data_source = await _resolve_ticker_stats(ticker, source=source)
    return {
        "row": row,
        "meta": {
            "generated_at": datetime.now(tz=UTC).isoformat(),
            "data_source": data_source,
        },
    }


@app.patch("/api/portfolio/{ticker}")
def patch_position(ticker: str, patch: PortfolioPositionPatch):
    ticker_upper = ticker.upper()
    positions = _load_positions()
    idx = _find_position_index(positions, ticker_upper)

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
    _save_positions(positions)
    return {"status": "ok", "ticker": ticker_upper, "position": positions[idx]}


@app.delete("/api/portfolio/{ticker}")
def remove_position(ticker: str):
    ticker_upper = ticker.upper()
    positions = [p for p in _load_positions() if p.get("ticker", "").upper() != ticker_upper]
    _save_positions(positions)
    return {"status": "ok", "ticker": ticker_upper}


@app.post("/api/portfolio/import-image")
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
    positions = [] if replace else _load_positions()
    index_by_ticker = {str(pos.get("ticker", "")).upper(): idx for idx, pos in enumerate(positions)}
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
        if ticker in index_by_ticker:
            existing = dict(positions[index_by_ticker[ticker]])
            existing["quantity"] = quantity
            if strategy:
                existing["strategy"] = strategy
            positions[index_by_ticker[ticker]] = StoredPortfolioPosition.model_validate(existing).to_storage_dict()
        else:
            positions.append(validated)
            index_by_ticker[ticker] = len(positions) - 1

        applied.append({"ticker": ticker, "quantity": quantity})

    _save_positions(positions)
    return {
        "status": "ok",
        "applied_count": len(applied),
        "applied": applied,
        "replace": replace,
    }


@app.get("/api/eval")
def eval_api(response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return load_json(EVAL_PATH, default={})


@app.get("/api/color-standards")
def color_standards_api(response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return {
        "standards": {
            "market_cap": {"min": MarketCapConfig.MIN, "max": MarketCapConfig.MAX},
            "pe": {
                "min": CalibrationConfig.TRAILING_PE_RANGE[0],
                "max": CalibrationConfig.TRAILING_PE_RANGE[2],
            },
            "pe_forward": {
                "min": CalibrationConfig.FORWARD_PE_RANGE[0],
                "max": CalibrationConfig.FORWARD_PE_RANGE[2],
            },
            "peg": {
                "min": CalibrationConfig.PEG_RANGE[0],
                "max": CalibrationConfig.PEG_RANGE[2],
            },
            "revenue_growth": {
                "min": CalibrationConfig.REVENUE_GROWTH_PCT_RANGE[0],
                "max": CalibrationConfig.REVENUE_GROWTH_PCT_RANGE[2],
            },
            "gross_margin": {
                "min": CalibrationConfig.GROSS_MARGIN_PCT_RANGE[0],
                "max": CalibrationConfig.GROSS_MARGIN_PCT_RANGE[2],
            },
            "debt_to_equity": {
                "min": CalibrationConfig.DEBT_TO_EQUITY_PCT_RANGE[0],
                "max": CalibrationConfig.DEBT_TO_EQUITY_PCT_RANGE[2],
            },
            "median_upside": {
                "min": CalibrationConfig.UPSIDE_RANGE[0],
                "max": CalibrationConfig.UPSIDE_RANGE[2],
            },
            "bull_probability": {
                "min": CalibrationConfig.PROBABILITY_RANGE[0],
                "max": CalibrationConfig.PROBABILITY_RANGE[2],
            },
            "bear_probability": {
                "min": CalibrationConfig.PROBABILITY_RANGE[0],
                "max": CalibrationConfig.PROBABILITY_RANGE[2],
            },
            "rsi": {"min": 20.0, "max": 80.0},
            "overall_score": {"min": 2.0, "max": 8.0},
            "quality_score": {"min": 2.0, "max": 8.0},
            "valuation_score": {"min": 2.0, "max": 8.0},
            "moat_score": {"min": 2.0, "max": 8.0},
            "upside_score": {"min": 2.0, "max": 8.0},
        }
    }


@app.get("/api/news/{ticker}")
def news_api(ticker: str) -> list[dict]:
    return [
        {
            "title": f"Strategic analysis of {ticker} performance",
            "url": f"https://example.com/{ticker}-news-1",
            "summary": f"A deep dive into {ticker}'s latest quarterly results and future outlook.",
            "relevancy": "high",
            "category": "company_news",
            "sentiment": "bullish",
        },
        {
            "title": f"Market trends affecting {ticker}",
            "url": f"https://example.com/{ticker}-news-2",
            "summary": f"Recent sector rotation and macroeconomic factors impacting {ticker}.",
            "relevancy": "medium",
            "category": "market_news",
            "sentiment": "neutral",
        },
    ]


@app.get("/api/evaluate/{ticker}")
def evaluate_ticker_api(ticker: str) -> dict:
    indicator = StockIndicator(ticker)

    return {
        "ticker": ticker.upper(),
        "rank": 1,
        "overall_score": 8.5,
        "moat_score": 9.0,
        "quality_score": 8.0,
        "valuation_score": 7.5,
        "upside_score": 10.0,
        "market_cap_score": 9.0,
        "bull_probability": 0.7,
        "bear_probability": 0.2,
        "price": indicator.price,
        "change_percent": indicator.change_percent,
        "rsi": indicator.rsi,
    }


app.mount("/", StaticFiles(directory=UI_DIR), name="ui")
