import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import logging
from pathlib import Path
import random

import yfinance as yf

from stock_search.evaluation.evaluation import evaluate_asset
from stock_search.evaluation.scores import (
    calculate_combined_upside_score,
    calculate_valuation_score,
    market_cap_score,
)
from stock_search.indicators import MARKET_CAP_UNITS, parse_ratings
from stock_search.schemas import Evaluation, ScoredReason

# Mute yfinance logging
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# Constants
RSI_PERIOD = 14
RSI_HISTORY_BUFFER = 10
RSI_MAX = 100.0

# Quantity generation
QUANTITY_MIN = 5
QUANTITY_MAX = 50
TARGET_TOTAL_EQUITY = 1_000_000.0
MAX_POSITION_QTY = 500

BUCKETS = ["Strategic Core", "Growth Satellites", "Tactical Opportunities", "Risk Mitigation"]

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


def fetch_stats_data(ticker: str) -> dict:
    """Fetch real-time market data + indicator snapshot for a ticker."""
    stock = yf.Ticker(ticker)
    info = stock.info or {}

    raw_price = info.get("regularMarketPrice") or info.get("currentPrice")
    price = _round(raw_price, 2)
    if price is not None and price <= 0:
        price = None

    raw_change = info.get("regularMarketChangePercent")
    change_percent = _round(raw_change, 2)

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
        "current_price": price,
        "change_percent": change_percent,
        "bucket": random.choice(BUCKETS),
        "name": info.get("shortName") or info.get("longName"),
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
        "_raw_info_snapshot": info,  # Kept for scoring logic
    }


def create_fallback_stats(ticker: str) -> dict:
    """Create fallback stats for failed ticker fetches."""
    return {
        "current_price": None,
        "change_percent": None,
        "bucket": random.choice(BUCKETS),
        "name": ticker,
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
        "_market_cap_raw": None,
        "_raw_info_snapshot": {},
    }


def generate_eval_entry(ticker: str, stats: dict) -> dict:
    """Generate evaluation scores for a ticker using statistical proxies."""
    info = stats.get("_raw_info_snapshot") or {}

    # 1. Calculate Scores using indicators/metrics
    size_score = market_cap_score(ticker, info) or 5.0
    valuation_score = calculate_valuation_score(info) or 5.0

    m_upside = stats.get("median_upside")
    upside_score = calculate_combined_upside_score(m_upside, ratings=None, outlook_score=None) or 5.0

    # 2. Momentum proxy (Bull Probability)
    trends = [stats.get("twenty_day_change_percent"), stats.get("fifty_day_change_percent"), stats.get("two_hundred_day_change_percent")]
    valid_trends = [v for v in trends if v is not None]
    avg_trend = sum(valid_trends) / len(valid_trends) if valid_trends else 0
    p_up = max(0.3, min(0.8, 0.55 + (avg_trend / 100.0)))
    p_down = 0.2

    # 3. Dynamic placeholders (Moat/Quality) based on proxies
    mkt_cap = info.get("marketCap") or 0
    margin_val = (stats.get("gross_margin") or 0) / 100.0

    # Moat proxy: Scale + Ecosystem
    moat_score = 4.0
    if mkt_cap > 1e12:
        moat_score = 9.5
    elif mkt_cap > 500e9:
        moat_score = 8.5
    elif mkt_cap > 100e9:
        moat_score = 7.0

    # Quality proxy: Profitability
    quality_score = 4.5
    if margin_val > 0.70:
        quality_score = 9.5
    elif margin_val > 0.40:
        quality_score = 8.0
    elif margin_val > 0.25:
        quality_score = 6.5

    # Assemble the eval entry to match Evaluation schema + flat properties
    # Note: We return a dict that matches the 'eval.json' structure

    # Compute overall score roughly matching the Core Index logic
    overall = (moat_score + quality_score + valuation_score + upside_score) / 4.0

    return {
        "overall": round(overall, 1),
        "quality": round(quality_score, 1),
        "valuation": round(valuation_score, 1),
        "moat": round(moat_score, 1),
        "upside": round(upside_score, 1),
        "market_cap": round(size_score, 1) if size_score else None,
        "bull_probability": round(p_up, 2),
        "bear_probability": round(p_down, 2),
        # Internal fields for allocation logic can be re-derived or passed along if needed
        # But here we just return the "view" data
    }


def allocate_portfolio(stats_map: dict[str, dict], eval_map: dict[str, dict]) -> list[dict]:
    """Allocate portfolio quantities based on stats and eval data."""
    scores: dict[str, float] = {}
    tickers = list(stats_map.keys())

    for ticker in tickers:
        stats = stats_map[ticker]
        eval_data = eval_map[ticker]

        # Re-construct Evaluation object for the engine
        # We use the values already computed in generate_eval_entry

        # Note: evaluate_asset needs ScoredReason objects
        moat_score = eval_data.get("moat") or 5.0
        quality_score = eval_data.get("quality") or 5.0

        eval_input = Evaluation(
            score=eval_data.get("overall") or 5.0,
            reasons=["Engine proxy"],
            market_cap=eval_data.get("market_cap") or 5.0,
            valuation=eval_data.get("valuation") or 5.0,
            upside=eval_data.get("upside") or 5.0,
            bull_probability=eval_data.get("bull_probability"),
            bear_probability=eval_data.get("bear_probability"),
            moat=ScoredReason(score=moat_score, reasons=["Proxy"]),
            quality=ScoredReason(score=quality_score, reasons=["Proxy"]),
        )

        res = evaluate_asset(eval_input, ticker=ticker)
        base_weight = res.core_index or 1.0

        pillar_boost = 1.0
        if ticker == "NVDA":
            pillar_boost = 1.5
        elif ticker == "GOOGL":
            pillar_boost = 1.3
        elif ticker in ["MSFT", "AAPL", "AVGO", "META"]:
            pillar_boost = 1.2

        scores[ticker] = base_weight * pillar_boost

    score_sum = sum(scores.values())
    portfolio_entries = []

    for ticker in tickers:
        stats = stats_map[ticker]
        price = stats.get("current_price")

        try:
            numeric_price = float(price) if price is not None else 0.0
        except (TypeError, ValueError):
            numeric_price = 0.0

        if numeric_price <= 0:
            continue

        allocation = TARGET_TOTAL_EQUITY * (scores[ticker] / score_sum) if score_sum > 0 else (TARGET_TOTAL_EQUITY / len(tickers))
        qty = round(allocation / numeric_price)
        qty = max(1, min(qty, MAX_POSITION_QTY))

        portfolio_entries.append({"ticker": ticker, "quantity": float(qty), "delta": 1.0})

    return portfolio_entries


def get_existing_tickers() -> list[str]:
    """Get tickers from existing portfolio if available."""
    tickers = set()

    # Check data/portfolio.json
    try:
        path = Path("data/portfolio.json")
        if path.exists():
            data = json.loads(path.read_text())
            # Handle both list format and legacy dict format
            rows = data if isinstance(data, list) else data.get("rows") or data.get("positions", [])
            for row in rows:
                if row.get("ticker"):
                    tickers.add(row["ticker"])
    except Exception as e:
        print(f"Warning: Could not read data/portfolio.json: {e}")

    # Check ui/sample_data/portfolio.json
    try:
        path = Path("ui/sample_data/portfolio.json")
        if path.exists():
            data = json.loads(path.read_text())
            rows = data if isinstance(data, list) else data.get("rows") or data.get("positions", [])
            for row in rows:
                if row.get("ticker"):
                    tickers.add(row["ticker"])
    except Exception as e:
        print(f"Warning: Could not read ui/sample_data/portfolio.json: {e}")

    return list(tickers)


def generate_static_data(prod: bool = False):
    """Main generation orchestration."""

    # Merge hardcoded samples with existing portfolio tickers
    existing_tickers = get_existing_tickers()
    all_tickers = sorted(set(SAMPLE_TICKERS + existing_tickers))

    print(f"Generating data for {len(all_tickers)} tickers (Sample: {len(SAMPLE_TICKERS)}, Existing: {len(existing_tickers)})...")

    # 1. Fetch Stats
    stats_map = {}
    print("Fetching stats...")

    def safe_fetch(ticker: str) -> tuple[str, dict]:
        try:
            return ticker, fetch_stats_data(ticker)
        except Exception as e:
            print(f"    ! Error fetching {ticker}: {e}")
            return ticker, create_fallback_stats(ticker)

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(safe_fetch, all_tickers))
        stats_map = dict(results)

    # 2. Generate Eval
    print("Generating evals...")
    # Now uses the fetched stats to generate realistic proxies
    eval_map = {ticker: generate_eval_entry(ticker, stats_map[ticker]) for ticker in all_tickers}

    # 3. Allocate Portfolio
    print("Allocating portfolio...")
    portfolio_list = allocate_portfolio(stats_map, eval_map)

    # 4. Clean up Stats (remove internal fields)
    for data in stats_map.values():
        data.pop("_raw_info_snapshot", None)
        data.pop("_market_cap_raw", None)

    # 5. Save
    print("Saving files...")

    def write_json(path: Path, data):
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    # Always save to ui/sample_data for frontend dev
    sample_dir = Path("ui/sample_data")
    sample_dir.mkdir(parents=True, exist_ok=True)

    write_json(sample_dir / "portfolio.json", portfolio_list)
    write_json(sample_dir / "stats.json", stats_map)
    write_json(sample_dir / "eval.json", eval_map)
    print(f"Saved to {sample_dir}")

    # Conditionally save to data/ for backend use
    if prod:
        data_dir = Path("data")
        data_dir.mkdir(parents=True, exist_ok=True)

        write_json(data_dir / "portfolio.json", portfolio_list)
        write_json(data_dir / "stats.json", stats_map)
        write_json(data_dir / "eval.json", eval_map)
        print(f"Saved to {data_dir}")
    else:
        print("Skipping save to data/ (use --prod to save there)")

    print(f"SUCCESS: Generated {len(portfolio_list)} positions.")
    print(f"Stats: {len(stats_map)} entries")
    print(f"Evals: {len(eval_map)} entries")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate static data for stock search.")
    parser.add_argument("--prod", action="store_true", help="Write output to data/ directory for production use")
    args = parser.parse_args()

    generate_static_data(prod=args.prod)
