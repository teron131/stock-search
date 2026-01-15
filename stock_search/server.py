from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import pandas as pd

from stock_search.dashboard import _load_portfolio, get_dashboard
from stock_search.indicators import StockIndicator
from stock_search.schemas import Portfolio, PortfolioPosition

BASE_DIR = Path(__file__).resolve().parent
UI_DIR = BASE_DIR.parent / "ui"
INDEX_FILE = UI_DIR / "index.html"
DATA_DIR = BASE_DIR.parent / "data"
PORTFOLIO_PATH = DATA_DIR / "portfolio.json"
EVAL_PATH = DATA_DIR / "eval.json"

app = FastAPI(title="Stock Search Dashboard")


def _save_portfolio(portfolio: Portfolio, path: Path = PORTFOLIO_PATH) -> None:
    """Save portfolio data to JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(portfolio.model_dump_json(indent=2))


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(INDEX_FILE)


@app.get("/api/dashboard")
def dashboard_api() -> dict:
    df = get_dashboard(PORTFOLIO_PATH)
    df = df.where(pd.notna(df), None)
    return {
        "columns": list(df.columns),
        "rows": df.to_dict(orient="records"),
    }


@app.get("/api/eval")
def eval_api() -> list[dict]:
    if not EVAL_PATH.exists():
        return []
    return json.loads(EVAL_PATH.read_text())


@app.get("/api/news/{ticker}")
def news_api(ticker: str) -> list[dict]:
    """Return dummy news for a ticker to avoid LLM costs."""
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
    """Return dummy evaluation metrics combining real prices with dummy research."""
    indicator = StockIndicator(ticker)

    # Combined dummy research with real indicator data
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
    indicator = StockIndicator(position.ticker)
    if indicator.price is None:
        raise HTTPException(status_code=400, detail=f"Invalid ticker: {position.ticker}")

    portfolio = _load_portfolio(PORTFOLIO_PATH)
    ticker_upper = position.ticker.upper()

    for i, p in enumerate(portfolio.positions):
        if p.ticker.upper() == ticker_upper:
            portfolio.positions[i] = position
            break
    else:
        portfolio.positions.append(position)

    _save_portfolio(portfolio)
    return {"status": "ok"}


@app.delete("/api/portfolio/position/{ticker}")
def remove_position(ticker: str):
    portfolio = _load_portfolio(PORTFOLIO_PATH)
    ticker_upper = ticker.upper()
    portfolio.positions = [p for p in portfolio.positions if p.ticker.upper() != ticker_upper]
    _save_portfolio(portfolio)
    return {"status": "ok"}


# Mount UI last so it doesn't shadow the API routes
app.mount("/", StaticFiles(directory=UI_DIR), name="ui")
