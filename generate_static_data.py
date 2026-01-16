from concurrent.futures import ThreadPoolExecutor
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
    "AAPL",
    "ABNB",
    "ADP",
    "ADBE",
    "AFRM",
    "AMRS",
    "AMZN",
    "AMD",
    "ARKK",
    "AVGO",
    "BBAI",
    "BITB",
    "BMNR",
    "CIFR",
    "CLSK",
    "COIN",
    "COST",
    "CRM",
    "CRWD",
    "CSCO",
    "DASH",
    "DDOG",
    "DOCN",
    "ETSY",
    "FTNT",
    "GE",
    "GEVO",
    "GLD",
    "GOOGL",
    "GS",
    "HOOD",
    "IBM",
    "INTC",
    "ITA",
    "JPM",
    "MAGS",
    "MARA",
    "META",
    "MSTR",
    "MSFT",
    "MS",
    "MU",
    "NFLX",
    "NOW",
    "NVDA",
    "NVAX",
    "ORCL",
    "PANW",
    "PINS",
    "PLTR",
    "PYPL",
    "QCOM",
    "RIOT",
    "RKLB",
    "ROKU",
    "RTX",
    "SARK",
    "SHOP",
    "SLV",
    "SNAP",
    "SNOW",
    "SOFI",
    "SOXX",
    "SPOT",
    "SQ",
    "TSLA",
    "TSM",
    "UBER",
    "UNH",
    "UPST",
    "VOO",
    "WDAY",
    "XOM",
    "ZM",
    "V",
    "MA",
    "JNJ",
    "PG",
    "KO",
    "DIS",
    "NKE",
    "BA",
    "CVX",
    "PFE",
    "MRK",
    "T",
    "VZ",
    "WMT",
    "HD",
    "LOW",
    "CAT",
    "DE",
    "ABT",
    "CSX",
    "INTU",
    "TXN",
    "AMAT",
    "LMT",
    "NEE",
]


def calculate_rsi(ticker_obj, days=RSI_PERIOD):
    """Calculate RSI indicator for a ticker."""
    try:
        hist = ticker_obj.history(period=f"{days + RSI_HISTORY_BUFFER}d")
        if hist.empty or len(hist) < days + 1:
            return None
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
        return None


def fetch_ticker_data(ticker: str) -> dict:
    """Fetch real-time market data for a single ticker."""
    stock = yf.Ticker(ticker)
    info = stock.info

    qty = random.randint(QUANTITY_MIN, QUANTITY_MAX)

    raw_price = info.get("regularMarketPrice") or info.get("currentPrice")
    price = round(raw_price, 2) if raw_price is not None else None
    if price is not None and price <= 0:
        price = None

    raw_change = info.get("regularMarketChangePercent")
    change_percent = round(raw_change, 2) if raw_change is not None else None

    rsi = calculate_rsi(stock)
    notional = round(qty * price, 2) if price is not None else None

    return {
        "ticker": ticker,
        "quantity": qty,
        "current_price": price,
        "change_percent": change_percent,
        "notional": notional,
        "bucket": random.choice(BUCKETS),
        "rsi": rsi,
        "weight_pct": None,
    }


def create_fallback_row(ticker: str) -> dict:
    """Create fallback row for failed ticker fetches."""
    return {
        "ticker": ticker,
        "quantity": random.randint(QUANTITY_MIN, QUANTITY_MAX),
        "current_price": None,
        "change_percent": None,
        "notional": None,
        "bucket": random.choice(BUCKETS),
        "rsi": None,
        "weight_pct": None,
    }


def calculate_portfolio_weights(rows: list[dict]) -> None:
    """Calculate and update portfolio weights in-place."""
    total_val = sum((r.get("notional") or 0) for r in rows)

    for r in rows:
        notional = r.get("notional")
        if total_val > 0 and notional is not None:
            r["weight_pct"] = round((notional / total_val) * 100, 2)
        else:
            r["weight_pct"] = None


def generate_portfolio_data(tickers: list[str]) -> tuple[list[dict], str]:
    """Generate portfolio data with live market prices."""
    generated_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    print(f"Fetching real-time data for {len(tickers)} tickers...")

    def safe_fetch(ticker: str) -> dict:
        try:
            return fetch_ticker_data(ticker)
        except Exception as e:
            print(f"    ! Error fetching {ticker}: {e}")
            return create_fallback_row(ticker)

    with ThreadPoolExecutor(max_workers=8) as executor:
        rows = list(executor.map(safe_fetch, tickers))

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

    data_dir = Path("data")
    data_dir.mkdir(parents=True, exist_ok=True)

    dashboard = {"rows": portfolio_rows, "generated_at": generated_at}
    (sample_data_dir / "portfolio.json").write_text(json.dumps(dashboard, indent=2), encoding="utf-8")
    (sample_data_dir / "eval.json").write_text(json.dumps(eval_data, indent=2), encoding="utf-8")

    (data_dir / "eval.json").write_text(json.dumps(eval_data, indent=2), encoding="utf-8")

    positions = [
        {
            "ticker": row["ticker"],
            "name": row["ticker"],
            "quantity": float(row["quantity"]),
            "bucket": row["bucket"],
            "delta": 1.0,
            "current_price": row["current_price"],
        }
        for row in portfolio_rows
    ]

    total_equity = sum((row.get("notional") or 0) for row in portfolio_rows)
    portfolio_doc = {"total_equity": total_equity, "positions": positions}
    (data_dir / "portfolio.json").write_text(json.dumps(portfolio_doc, indent=2), encoding="utf-8")

    print(f"\nSUCCESS: Updated ui/sample_data and data/ at {generated_at}.")


def generate_sample_data():
    """Generate sample portfolio and evaluation data."""
    portfolio_rows, generated_at = generate_portfolio_data(SAMPLE_TICKERS)
    eval_data = generate_eval_data(SAMPLE_TICKERS)
    save_sample_data(portfolio_rows, eval_data, generated_at)


if __name__ == "__main__":
    generate_sample_data()
