from datetime import UTC, datetime
import json
import logging
from pathlib import Path
import random

import yfinance as yf

# Mute yfinance logging
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# Constants
RSI_PERIOD = 14
RSI_HISTORY_BUFFER = 10
RSI_DEFAULT = 50.0
RSI_MAX = 100.0

QUANTITY_MIN = 50
QUANTITY_MAX = 100

BUCKETS = ["Strategic Core", "Growth Satellites", "Tactical Opportunities", "Risk Mitigation"]

EVAL_SCORE_RANGES = {
    "overall": (6.0, 9.5),
    "quality": (6.0, 9.5),
    "valuation": (3.0, 8.0),
    "moat": (5.0, 9.8),
    "upside": (5.0, 20.0),
}

SAMPLE_TICKERS = [
    "NVDA",
    "GOOGL",
    "TSM",
    "AAPL",
    "AMD",
    "BMNR",
    "SOXX",
    "TSLA",
    "VOO",
    "JPM",
    "GE",
    "RTX",
    "SOFI",
    "HOOD",
    "GLD",
    "SLV",
    "UNH",
    "MAGS",
    "ITA",
    "PLTR",
    "MU",
    "XOM",
    "GS",
    "MS",
    "RKLB",
]


def calculate_rsi(ticker_obj, days=RSI_PERIOD):
    """Calculate RSI indicator for a ticker."""
    try:
        hist = ticker_obj.history(period=f"{days + RSI_HISTORY_BUFFER}d")
        if hist.empty or len(hist) < days + 1:
            return RSI_DEFAULT
        deltas = hist["Close"].diff()
        gains = deltas.where(deltas > 0, 0)
        losses = -deltas.where(deltas < 0, 0)
        avg_gain = float(gains.rolling(window=days).mean().iloc[-1])
        avg_loss = float(losses.rolling(window=days).mean().iloc[-1])
        if avg_loss == 0:
            return RSI_MAX
        rs = avg_gain / avg_loss
        return round(100 - (100 / (1 + rs)), 2)
    except Exception:
        return RSI_DEFAULT


def fetch_ticker_data(ticker: str) -> dict:
    """Fetch real-time market data for a single ticker."""
    stock = yf.Ticker(ticker)
    info = stock.info

    qty = random.randint(QUANTITY_MIN, QUANTITY_MAX)
    price = info.get("regularMarketPrice") or info.get("currentPrice") or 0.0
    change = info.get("regularMarketChangePercent") or 0.0
    rsi = calculate_rsi(stock)

    return {
        "ticker": ticker,
        "quantity": qty,
        "current_price": round(price, 2),
        "change_percent": round(change, 2),
        "notional": round(qty * price, 2),
        "bucket": random.choice(BUCKETS),
        "rsi": rsi,
        "weight_pct": 0,
    }


def create_fallback_row(ticker: str) -> dict:
    """Create fallback row for failed ticker fetches."""
    return {
        "ticker": ticker,
        "quantity": random.randint(QUANTITY_MIN, QUANTITY_MAX),
        "current_price": 0.0,
        "change_percent": 0.0,
        "notional": 0.0,
        "bucket": "Unknown",
        "rsi": RSI_DEFAULT,
        "weight_pct": 0,
    }


def calculate_portfolio_weights(rows: list[dict]) -> None:
    """Calculate and update portfolio weights in-place."""
    total_val = sum(r["notional"] for r in rows)
    for r in rows:
        if total_val > 0:
            r["weight_pct"] = round((r["notional"] / total_val) * 100, 2)


def generate_portfolio_data(tickers: list[str]) -> tuple[list[dict], str]:
    """Generate portfolio data with live market prices."""
    generated_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = []

    print(f"Fetching real-time data for {len(tickers)} tickers...")

    for ticker in tickers:
        print(f"  > Processing {ticker}...")
        try:
            rows.append(fetch_ticker_data(ticker))
        except Exception as e:
            print(f"    ! Error fetching {ticker}: {e}")
            rows.append(create_fallback_row(ticker))

    calculate_portfolio_weights(rows)
    return rows, generated_at


def generate_eval_data(tickers: list[str]) -> list[dict]:
    """Generate evaluation scores for tickers."""
    return [
        {
            "ticker": ticker,
            "rank": i + 1,
            "overall": round(random.uniform(*EVAL_SCORE_RANGES["overall"]), 1),
            "quality": round(random.uniform(*EVAL_SCORE_RANGES["quality"]), 1),
            "valuation": round(random.uniform(*EVAL_SCORE_RANGES["valuation"]), 1),
            "moat": round(random.uniform(*EVAL_SCORE_RANGES["moat"]), 1),
            "upside": round(random.uniform(*EVAL_SCORE_RANGES["upside"]), 1),
            "bull": 0.7,
            "bear": 0.2,
        }
        for i, ticker in enumerate(tickers)
    ]


def save_sample_data(portfolio_rows: list[dict], eval_data: list[dict], generated_at: str) -> None:
    """Save generated data to JSON files."""
    sample_data_dir = Path("ui/sample_data")
    sample_data_dir.mkdir(parents=True, exist_ok=True)

    dashboard = {"rows": portfolio_rows, "generated_at": generated_at}
    (sample_data_dir / "portfolio.json").write_text(json.dumps(dashboard, indent=2))
    (sample_data_dir / "eval.json").write_text(json.dumps(eval_data, indent=2))

    print(f"\nSUCCESS: Sample data generated at {generated_at} with REAL API stats.")


def generate_sample_data():
    """Generate sample portfolio and evaluation data."""
    portfolio_rows, generated_at = generate_portfolio_data(SAMPLE_TICKERS)
    eval_data = generate_eval_data(SAMPLE_TICKERS)
    save_sample_data(portfolio_rows, eval_data, generated_at)


if __name__ == "__main__":
    generate_sample_data()
