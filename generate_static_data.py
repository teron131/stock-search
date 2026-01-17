from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from datetime import UTC, datetime
import json
import logging
import math
from pathlib import Path
import random

import yfinance as yf

from stock_search.indicators import MARKET_CAP_UNITS, parse_ratings

# Mute yfinance logging
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# Constants
RSI_PERIOD = 14
RSI_HISTORY_BUFFER = 10
RSI_DEFAULT = 50.0  # legacy default; prefer None for snapshots
RSI_MAX = 100.0

# Quantity generation is score-based (see assign_quantities).
# These are only used as a fallback when we can't size a position.
QUANTITY_MIN = 5
QUANTITY_MAX = 50

TARGET_TOTAL_EQUITY = 1_000_000.0
MAX_POSITION_QTY = 500

# Weights for sizing positions (higher is better unless noted)
# - market_cap: bigger is better
# - peg: lower is better (inverted)
# - gross_margin: bigger is better
# - median_upside: bigger is better
POSITION_SCORE_WEIGHTS = {
    "market_cap": 0.5,
    "peg": 0.3,
    "gross_margin": 0.1,
    "median_upside": 0.1,
}

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
    "ABT",
    "ADP",
    "ADBE",
    "AFRM",
    "AMAT",
    "AMRS",
    "AMZN",
    "AMD",
    "ARKK",
    "AVGO",
    "BA",
    "BBAI",
    "BITB",
    "BMNR",
    "CAT",
    "CIFR",
    "CLSK",
    "COIN",
    "COST",
    "CRM",
    "CRWD",
    "CSX",
    "CSCO",
    "CVX",
    "DASH",
    "DDOG",
    "DE",
    "DIS",
    "DOCN",
    "ETSY",
    "FTNT",
    "GE",
    "GEVO",
    "GLD",
    "GOOGL",
    "GS",
    "HD",
    "HOOD",
    "IBM",
    "INTC",
    "INTU",
    "ITA",
    "JNJ",
    "JPM",
    "KO",
    "LMT",
    "LOW",
    "MAGS",
    "MARA",
    "MA",
    "MRK",
    "META",
    "MSTR",
    "MSFT",
    "MS",
    "MU",
    "NEE",
    "NFLX",
    "NKE",
    "NOW",
    "NVDA",
    "NVAX",
    "ORCL",
    "PANW",
    "PFE",
    "PG",
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
    "T",
    "TSLA",
    "TSM",
    "TXN",
    "UBER",
    "UNH",
    "UPST",
    "V",
    "VOO",
    "VZ",
    "WDAY",
    "WMT",
    "XOM",
    "ZM",
]


def _round(value: float | None, decimals: int = 2) -> float | None:
    if value is None:
        return None
    try:
        return round(float(value), decimals)
    except (TypeError, ValueError):
        return None


def _format_market_cap(market_cap: float | None) -> str | None:
    if market_cap is None:
        return None
    try:
        value = float(market_cap)
    except (TypeError, ValueError):
        return None

    for divisor, suffix in MARKET_CAP_UNITS:
        if value >= divisor:
            return f"{value / divisor:.3f}{suffix}"
    return f"{value:.3f}"


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
    """Fetch real-time market data + indicator snapshot for a ticker.

    This should populate all fields needed for the UI holdings table.
    If a field can't be fetched, we leave it as None so the UI renders "--".

    Quantity is assigned in a second pass after we have cross-ticker metrics.
    """
    stock = yf.Ticker(ticker)
    info = stock.info or {}

    qty: int | None = None

    raw_price = info.get("regularMarketPrice") or info.get("currentPrice")
    price = _round(raw_price, 2)
    if price is not None and price <= 0:
        price = None

    raw_change = info.get("regularMarketChangePercent")
    change_percent = _round(raw_change, 2)

    notional = None  # computed after quantity assignment

    market_cap_raw = _round(info.get("marketCap"), 0)
    market_cap = _format_market_cap(market_cap_raw)
    pe = _round(info.get("trailingPE"), 2)
    pe_forward = _round(info.get("forwardPE"), 2)
    peg = _round(info.get("trailingPegRatio"), 2)

    earning_direction = None
    if pe is not None and pe_forward is not None:
        earning_direction = "Increase" if pe > pe_forward else "Decrease"

    gross_margin = None
    if (raw_margin := info.get("grossMargins")) is not None:
        gross_margin = _round(raw_margin * 100, 2)

    # Trend change % values in yfinance info are typically ratios (0.12 -> 12%).
    def pct_from_ratio(key: str) -> float | None:
        if (raw := info.get(key)) is None:
            return None
        return _round(raw * 100, 2)

    twenty_day_change_percent = pct_from_ratio("twentyDayAverageChangePercent")
    fifty_day_change_percent = pct_from_ratio("fiftyDayAverageChangePercent")
    one_hundred_day_change_percent = pct_from_ratio("oneHundredDayAverageChangePercent")
    two_hundred_day_change_percent = pct_from_ratio("twoHundredDayAverageChangePercent")

    rsi = calculate_rsi(stock)

    median_upside = None
    try:
        ratings = parse_ratings(stock)
        if ratings:
            median_upside = ratings.get("median_upside_pct")
    except Exception:
        median_upside = None

    return {
        "ticker": ticker,
        "quantity": qty,
        "current_price": price,
        "change_percent": change_percent,
        "notional": notional,
        "bucket": random.choice(BUCKETS),
        "rsi": rsi,
        "twenty_day_change_percent": twenty_day_change_percent,
        "fifty_day_change_percent": fifty_day_change_percent,
        "one_hundred_day_change_percent": one_hundred_day_change_percent,
        "two_hundred_day_change_percent": two_hundred_day_change_percent,
        "median_upside": median_upside,
        "market_cap": market_cap,
        "_market_cap_raw": market_cap_raw,
        "pe": pe,
        "pe_forward": pe_forward,
        "peg": peg,
        "gross_margin": gross_margin,
        "earning_direction": earning_direction,
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
        "twenty_day_change_percent": None,
        "fifty_day_change_percent": None,
        "one_hundred_day_change_percent": None,
        "two_hundred_day_change_percent": None,
        "median_upside": None,
        "market_cap": None,
        "pe": None,
        "pe_forward": None,
        "peg": None,
        "gross_margin": None,
        "earning_direction": None,
        "weight_pct": None,
    }


def assign_quantities(rows: list[dict]) -> None:
    """Assign quantities based on cross-ticker fundamentals.

    Sizing logic:
    - Allocate a target total equity across tickers using a weighted score.
    - Score uses: market cap (bigger better), PEG (lower better), margin (bigger better), upside (bigger better).
    - Missing data is ignored for that ticker/metric.

    This mutates rows in place and computes `quantity` + `notional`.
    """

    def normalize(values_by_index: dict[int, float], *, invert: bool = False) -> dict[int, float]:
        if not values_by_index:
            return {}

        values = list(values_by_index.values())
        min_v = min(values)
        max_v = max(values)
        spread = max_v - min_v

        out: dict[int, float] = {}
        for idx, val in values_by_index.items():
            scaled = 0.5 if spread == 0 else (val - min_v) / spread
            out[idx] = 1 - scaled if invert else scaled
        return out

    cap_by_index: dict[int, float] = {}
    peg_by_index: dict[int, float] = {}
    margin_by_index: dict[int, float] = {}
    upside_by_index: dict[int, float] = {}

    for i, row in enumerate(rows):
        if row.get("current_price") is None:
            continue

        if (cap := row.get("_market_cap_raw")) is not None:
            with suppress(TypeError, ValueError):
                cap_by_index[i] = math.log10(float(cap))

        if (peg := row.get("peg")) is not None:
            with suppress(TypeError, ValueError):
                peg_by_index[i] = float(peg)

        if (margin := row.get("gross_margin")) is not None:
            with suppress(TypeError, ValueError):
                margin_by_index[i] = float(margin)

        if (upside := row.get("median_upside")) is not None:
            with suppress(TypeError, ValueError):
                upside_by_index[i] = float(upside)

    cap_norm = normalize(cap_by_index)
    peg_norm = normalize(peg_by_index, invert=True)
    margin_norm = normalize(margin_by_index)
    upside_norm = normalize(upside_by_index)

    scores: dict[int, float] = {}
    for i, row in enumerate(rows):
        price = row.get("current_price")
        if price is None:
            continue

        parts: list[tuple[float, float]] = []
        for key, weight in POSITION_SCORE_WEIGHTS.items():
            if key == "market_cap":
                val = cap_norm.get(i)
            elif key == "peg":
                val = peg_norm.get(i)
            elif key == "gross_margin":
                val = margin_norm.get(i)
            elif key == "median_upside":
                val = upside_norm.get(i)
            else:
                val = None

            if val is not None:
                parts.append((weight, val))

        if not parts:
            scores[i] = 1.0
            continue

        total_weight = sum(w for w, _ in parts)
        score = sum(w * v for w, v in parts) / total_weight
        scores[i] = max(score, 0.01)

    score_sum = sum(scores.values())

    for i, row in enumerate(rows):
        price = row.get("current_price")
        if price is None:
            row["quantity"] = row.get("quantity") or random.randint(QUANTITY_MIN, QUANTITY_MAX)
            row["notional"] = None
            continue

        allocation = TARGET_TOTAL_EQUITY
        if score_sum > 0:
            allocation = TARGET_TOTAL_EQUITY * (scores.get(i, 1.0) / score_sum)

        qty = round(allocation / float(price)) if price else random.randint(QUANTITY_MIN, QUANTITY_MAX)
        qty = max(1, min(qty, MAX_POSITION_QTY))

        row["quantity"] = qty
        row["notional"] = _round(qty * float(price), 2)

    # remove internal-only fields
    for row in rows:
        row.pop("_market_cap_raw", None)


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

    assign_quantities(rows)
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
