from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import pandas as pd

from stock_search.dashboard import _load_json, get_dashboard
from stock_search.indicators import StockIndicator
from stock_search.schemas import PortfolioPosition

BASE_DIR = Path(__file__).resolve().parent
UI_DIR = BASE_DIR.parent / "ui"
INDEX_FILE = UI_DIR / "index.html"
DATA_DIR = BASE_DIR.parent / "data"
PORTFOLIO_PATH = DATA_DIR / "portfolio.json"
STATS_PATH = DATA_DIR / "stats.json"
EVAL_PATH = DATA_DIR / "eval.json"

app = FastAPI(title="Stock Search Dashboard")


def _save_portfolio(portfolio_data: list[dict], path: Path = PORTFOLIO_PATH) -> None:
    """Save portfolio data to JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(portfolio_data, indent=2))


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(INDEX_FILE)


@app.get("/api/portfolio")
def portfolio_api() -> dict:
    """Get current portfolio with live prices and indicators."""
    df = get_dashboard(PORTFOLIO_PATH, STATS_PATH)
    df = df.where(pd.notna(df), None)

    # Get last modified time of the local data file
    generated_at = None
    if STATS_PATH.exists():
        mtime = STATS_PATH.stat().st_mtime
        generated_at = datetime.fromtimestamp(mtime, tz=UTC).isoformat()

    return {
        "columns": list(df.columns),
        "rows": df.to_dict(orient="records"),
        "generated_at": generated_at,
    }


@app.get("/api/eval")
def eval_api() -> dict:
    if not EVAL_PATH.exists():
        return {}
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
    # Validate ticker exists (optional, keeping original logic)
    indicator = StockIndicator(position.ticker)
    if indicator.price is None:
        raise HTTPException(status_code=400, detail=f"Invalid ticker: {position.ticker}")

    portfolio_data = _load_json(PORTFOLIO_PATH)
    # Handle if it loads as dict (legacy) vs list (new)
    if isinstance(portfolio_data, dict):
        portfolio_data = portfolio_data.get("positions", [])

    ticker_upper = position.ticker.upper()

    # Create the entry to save (minimal fields)
    new_entry = {"ticker": ticker_upper, "quantity": position.quantity or 0, "delta": position.delta or 1.0}

    found = False
    for i, p in enumerate(portfolio_data):
        if p.get("ticker", "").upper() == ticker_upper:
            portfolio_data[i] = new_entry
            found = True
            break

    if not found:
        portfolio_data.append(new_entry)

    _save_portfolio(portfolio_data)
    return {"status": "ok"}


@app.delete("/api/portfolio/position/{ticker}")
def remove_position(ticker: str):
    portfolio_data = _load_json(PORTFOLIO_PATH)
    if isinstance(portfolio_data, dict):
        portfolio_data = portfolio_data.get("positions", [])

    ticker_upper = ticker.upper()
    portfolio_data = [p for p in portfolio_data if p.get("ticker", "").upper() != ticker_upper]
    _save_portfolio(portfolio_data)
    return {"status": "ok"}


# Mount UI last so it doesn't shadow the API routes
app.mount("/", StaticFiles(directory=UI_DIR), name="ui")
