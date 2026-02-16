from __future__ import annotations

from datetime import UTC, datetime
import logging
from pathlib import Path
from time import perf_counter
from typing import Any

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import pandas as pd
from pydantic import BaseModel

from stock_search.evaluation.constants import CalibrationConfig, MarketCapConfig
from stock_search.file_utils import load_json, write_json
from stock_search.indicators import StockIndicator
from stock_search.portfolio import get_portfolio_payload

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


class StoredPortfolioPosition(BaseModel):
    ticker: str
    quantity: float = 0.0
    strategy: str | None = None

    def to_storage_dict(self) -> dict[str, Any]:
        payload = self.model_dump(exclude_none=True)
        payload["ticker"] = self.ticker.upper()
        return payload


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


def _get_dashboard_row(df: pd.DataFrame, ticker: str) -> dict[str, Any]:
    if df.empty or "ticker" not in df:
        raise HTTPException(status_code=404, detail=f"Ticker not found: {ticker}")

    ticker_upper = ticker.upper()
    matched = df[df["ticker"].astype(str).str.upper() == ticker_upper]
    if matched.empty:
        raise HTTPException(status_code=404, detail=f"Ticker not found: {ticker}")

    return matched.where(pd.notna(matched), None).iloc[0].to_dict()


@app.get("/api/portfolio")
def portfolio_api(response: Response, scope: str = "all") -> dict:
    response.headers["Cache-Control"] = "no-store"
    started_at = perf_counter()

    resolved_scope = scope if scope in _PORTFOLIO_SCOPE_CONFIG else "all"
    scope_config = _PORTFOLIO_SCOPE_CONFIG[resolved_scope]
    include_cached_universe = scope_config["include_cached_universe"]
    include_live_market = scope_config["include_live_market"]

    payload = get_portfolio_payload(
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
def portfolio_ticker_api(ticker: str, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"

    # Single-row read path: avoid full live/cached-universe rebuild.
    payload = get_portfolio_payload(
        PORTFOLIO_PATH,
        STATS_PATH,
        EVAL_PATH,
        include_cached_universe=False,
        include_live_market=False,
    )
    df = pd.DataFrame(payload["rows"])
    row = _get_dashboard_row(df, ticker)
    return {
        "row": row,
        "meta": {
            "generated_at": datetime.now(tz=UTC).isoformat(),
            "data_source": "cache",
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
        "market_cap": 9.0,
        "bull_probability": 0.7,
        "bear_probability": 0.2,
        "price": indicator.price,
        "change_percent": indicator.change_percent,
        "rsi": indicator.rsi,
    }


app.mount("/", StaticFiles(directory=UI_DIR), name="ui")
