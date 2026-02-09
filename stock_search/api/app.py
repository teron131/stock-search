from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import pandas as pd
from pydantic import BaseModel

from stock_search.dashboard import get_dashboard
from stock_search.evaluation.constants import CalibrationConfig, MarketCapConfig
from stock_search.evaluation.evaluation import build_inputs, evaluate_asset, strategy_label
from stock_search.file_utils import load_json, write_json
from stock_search.indicators import StockIndicator
from stock_search.news import get_news

BASE_DIR = Path(__file__).resolve().parents[1]
UI_DIR = BASE_DIR.parent / "ui"
INDEX_FILE = UI_DIR / "index.html"
DATA_DIR = BASE_DIR.parent / "data"
PORTFOLIO_PATH = DATA_DIR / "portfolio.json"
STATS_PATH = DATA_DIR / "stats.json"
EVAL_PATH = DATA_DIR / "eval.json"

app = FastAPI(title="Stock Search Dashboard")

# Expose backend `data/` to the UI (portfolio/eval/stats JSON)
# This must be mounted before the UI mount at "/".
app.mount("/data", StaticFiles(directory=DATA_DIR), name="data")


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(INDEX_FILE)


class PortfolioPositionPatch(BaseModel):
    quantity: float | None = None
    delta: float | None = None
    bucket: str | None = None


def _set_no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


def _load_positions() -> list[dict[str, Any]]:
    portfolio_data = load_json(PORTFOLIO_PATH, default=[])
    if isinstance(portfolio_data, dict):
        portfolio_data = portfolio_data.get("positions", [])
    return portfolio_data if isinstance(portfolio_data, list) else []


def _save_positions(positions: list[dict[str, Any]]) -> None:
    write_json(PORTFOLIO_PATH, positions)


def _normalize_position(
    *,
    ticker: str,
    quantity: float | None,
    delta: float | None,
    bucket: str | None = None,
) -> dict[str, Any]:
    normalized = {
        "ticker": ticker.upper(),
        "quantity": 0 if quantity is None else quantity,
        "delta": 0.0 if delta is None else delta,
    }
    if bucket:
        normalized["bucket"] = bucket
    return normalized


def _ensure_valid_new_ticker(ticker: str) -> None:
    indicator = StockIndicator(ticker)
    if indicator.price is None:
        raise HTTPException(status_code=400, detail=f"Invalid ticker: {ticker}")


def _find_position_index(positions: list[dict[str, Any]], ticker: str) -> int | None:
    ticker_upper = ticker.upper()
    return next(
        (
            index
            for index, position in enumerate(positions)
            if position.get("ticker", "").upper() == ticker_upper
        ),
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
def portfolio_api(response: Response) -> dict:
    _set_no_store(response)

    df = get_dashboard(PORTFOLIO_PATH, STATS_PATH, EVAL_PATH)
    df = df.where(pd.notna(df), None)

    # Timestamp for *this* response (not the cache file mtime)
    generated_at = datetime.now(tz=UTC).isoformat()

    return {
        "columns": list(df.columns),
        "rows": df.to_dict(orient="records"),
        "generated_at": generated_at,
    }


@app.get("/api/portfolio/{ticker}")
def portfolio_ticker_api(ticker: str, response: Response) -> dict:
    _set_no_store(response)

    df = get_dashboard(PORTFOLIO_PATH, STATS_PATH, EVAL_PATH)
    row = _get_dashboard_row(df, ticker)
    return {
        "row": row,
        "generated_at": datetime.now(tz=UTC).isoformat(),
    }


@app.patch("/api/portfolio/{ticker}")
def patch_position(ticker: str, patch: PortfolioPositionPatch):
    ticker_upper = ticker.upper()
    positions = _load_positions()
    idx = _find_position_index(positions, ticker_upper)

    if idx is None:
        if patch.quantity is None and patch.delta is None and patch.bucket is None:
            raise HTTPException(status_code=400, detail="Patch payload is empty.")
        _ensure_valid_new_ticker(ticker_upper)
        current = _normalize_position(
            ticker=ticker_upper,
            quantity=0,
            delta=0.0,
            bucket=None,
        )
        positions.append(current)
        idx = len(positions) - 1
    else:
        current = dict(positions[idx])

    if patch.quantity is not None:
        current["quantity"] = patch.quantity
    if patch.delta is not None:
        current["delta"] = patch.delta
    if patch.bucket is not None:
        if patch.bucket == "":
            current.pop("bucket", None)
        else:
            current["bucket"] = patch.bucket

    positions[idx] = current
    _save_positions(positions)
    return {"status": "ok", "ticker": ticker_upper, "position": current}


@app.delete("/api/portfolio/{ticker}")
def remove_position(ticker: str):
    ticker_upper = ticker.upper()
    positions = [
        p
        for p in _load_positions()
        if p.get("ticker", "").upper() != ticker_upper
    ]
    _save_positions(positions)
    return {"status": "ok", "ticker": ticker_upper}


@app.get("/api/eval")
def eval_api(response: Response) -> dict:
    _set_no_store(response)
    return load_json(EVAL_PATH, default={})


@app.get("/api/color-standards")
def color_standards_api(response: Response) -> dict:
    _set_no_store(response)
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
            "bull": {
                "min": CalibrationConfig.PROBABILITY_RANGE[0],
                "max": CalibrationConfig.PROBABILITY_RANGE[2],
            },
            "bear": {
                "min": CalibrationConfig.PROBABILITY_RANGE[0],
                "max": CalibrationConfig.PROBABILITY_RANGE[2],
            },
            "rsi": {"min": 20.0, "max": 80.0},
            "overall": {"min": 2.0, "max": 8.0},
            "quality": {"min": 2.0, "max": 8.0},
            "valuation": {"min": 2.0, "max": 8.0},
            "moat": {"min": 2.0, "max": 8.0},
            "upside": {"min": 2.0, "max": 8.0},
        }
    }


@app.get("/api/news/{ticker}")
def news_api(ticker: str, response: Response) -> list[dict[str, Any]]:
    _set_no_store(response)
    try:
        news_items = get_news(ticker)
    except Exception as exc:  # pragma: no cover - defensive path for provider failures
        raise HTTPException(status_code=502, detail="Failed to fetch news") from exc

    normalized: list[dict[str, Any]] = []
    for item in news_items or []:
        if hasattr(item, "model_dump"):
            normalized.append(item.model_dump())
        elif isinstance(item, dict):
            normalized.append(item)
    return normalized


@app.get("/api/evaluate/{ticker}")
def evaluate_ticker_api(ticker: str, response: Response) -> dict[str, Any]:
    _set_no_store(response)
    try:
        inputs = build_inputs(ticker)
        result = evaluate_asset(inputs, ticker=ticker.upper())
    except Exception as exc:  # pragma: no cover - defensive path for provider failures
        raise HTTPException(status_code=502, detail="Failed to evaluate ticker") from exc

    payload = asdict(result)
    payload["inputs"] = inputs.model_dump()
    payload["ticker"] = result.ticker or ticker.upper()
    payload["strategy_label"] = strategy_label(
        result.core_index,
        result.satellite_index,
        result.speculative_index,
        result.diversifier_index,
    )
    return payload


app.mount("/", StaticFiles(directory=UI_DIR), name="ui")
