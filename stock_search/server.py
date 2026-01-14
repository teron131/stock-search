from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import pandas as pd

from stock_search.dashboard import _load_portfolio, get_dashboard
from stock_search.schemas import PortfolioPosition

BASE_DIR = Path(__file__).resolve().parent
UI_DIR = BASE_DIR.parent / "ui"
INDEX_FILE = UI_DIR / "index.html"
PORTFOLIO_PATH = BASE_DIR.parent / "data" / "portfolio.json"

app = FastAPI(title="Stock Search Dashboard")

app.mount("/static", StaticFiles(directory=UI_DIR), name="static")


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(INDEX_FILE)


@app.get("/api/dashboard")
def dashboard_api(portfolio_path: str = "data/portfolio.json") -> dict:
    df = get_dashboard(portfolio_path)
    df = df.where(pd.notna(df), None)
    return {
        "columns": list(df.columns),
        "rows": df.to_dict(orient="records"),
    }


@app.get("/api/eval")
def eval_api() -> list[dict]:
    eval_path = BASE_DIR.parent / "data" / "eval.json"
    if not eval_path.exists():
        return []
    with open(eval_path) as f:
        return json.load(f)


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
    from stock_search.indicators import StockIndicator

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
    portfolio = _load_portfolio(PORTFOLIO_PATH)

    # Check if exists
    for i, p in enumerate(portfolio.positions):
        if p.ticker.upper() == position.ticker.upper():
            portfolio.positions[i] = position
            break
    else:
        portfolio.positions.append(position)

    with open(PORTFOLIO_PATH, "w") as f:
        f.write(portfolio.model_dump_json(indent=2))
    return {"status": "ok"}


@app.delete("/api/portfolio/position/{ticker}")
def remove_position(ticker: str):
    portfolio = _load_portfolio(PORTFOLIO_PATH)
    portfolio.positions = [p for p in portfolio.positions if p.ticker.upper() != ticker.upper()]
    with open(PORTFOLIO_PATH, "w") as f:
        f.write(portfolio.model_dump_json(indent=2))
    return {"status": "ok"}
