from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import pandas as pd

from stock_search.dashboard import get_dashboard
from stock_search.evaluation.constants import CalibrationConfig, MarketCapConfig
from stock_search.file_utils import load_json, write_json
from stock_search.indicators import StockIndicator
from stock_search.schemas import PortfolioPosition

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


@app.get("/api/portfolio")
def portfolio_api(response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"

    df = get_dashboard(PORTFOLIO_PATH, STATS_PATH, EVAL_PATH)
    df = df.where(pd.notna(df), None)

    # Timestamp for *this* response (not the cache file mtime)
    generated_at = datetime.now(tz=UTC).isoformat()

    return {
        "columns": list(df.columns),
        "rows": df.to_dict(orient="records"),
        "generated_at": generated_at,
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
        "overall": 8.5,
        "moat": 9.0,
        "quality": 8.0,
        "valuation": 7.5,
        "upside": 10.0,
        "market_cap": 9.0,
        "bull": 0.7,
        "bear": 0.2,
        "current_price": indicator.price,
        "change_percent": indicator.change_percent,
        "rsi": indicator.rsi,
    }


@app.post("/api/portfolio/position")
def add_position(position: PortfolioPosition):
    portfolio_data = load_json(PORTFOLIO_PATH, default=[])
    if isinstance(portfolio_data, dict):
        portfolio_data = portfolio_data.get("positions", [])

    ticker_upper = position.ticker.upper()
    is_existing = any(p.get("ticker", "").upper() == ticker_upper for p in portfolio_data)

    if not is_existing:
        indicator = StockIndicator(position.ticker)
        if indicator.price is None:
            raise HTTPException(status_code=400, detail=f"Invalid ticker: {position.ticker}")

    new_entry = {
        "ticker": ticker_upper,
        "quantity": position.quantity or 0,
        "delta": 0.0 if position.delta is None else position.delta,
    }

    for i, existing in enumerate(portfolio_data):
        if existing.get("ticker", "").upper() == ticker_upper:
            portfolio_data[i] = new_entry
            break
    else:
        portfolio_data.append(new_entry)

    write_json(PORTFOLIO_PATH, portfolio_data)
    return {"status": "ok"}


@app.delete("/api/portfolio/position/{ticker}")
def remove_position(ticker: str):
    portfolio_data = load_json(PORTFOLIO_PATH, default=[])
    if isinstance(portfolio_data, dict):
        portfolio_data = portfolio_data.get("positions", [])

    ticker_upper = ticker.upper()
    portfolio_data = [p for p in portfolio_data if p.get("ticker", "").upper() != ticker_upper]
    write_json(PORTFOLIO_PATH, portfolio_data)
    return {"status": "ok"}


app.mount("/", StaticFiles(directory=UI_DIR), name="ui")
