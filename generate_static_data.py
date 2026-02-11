import argparse
from concurrent.futures import ThreadPoolExecutor
import logging
from pathlib import Path
import random

from stock_search.common_utils import format_market_cap, round_optional
from stock_search.config import PortfolioConfig
from stock_search.evaluation.evaluation import evaluate_asset
from stock_search.evaluation.scores import (
    calculate_combined_upside_score,
    calculate_valuation_score,
    market_cap_score,
)
from stock_search.file_utils import load_json, write_json
from stock_search.indicators import StockIndicator
from stock_search.schemas import Evaluation, ScoredReason

# Mute yfinance logging
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

BUCKETS = [
    "Strategic Core",
    "Growth Satellites",
    "Tactical Opportunities",
    "Risk Mitigation",
]

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


def fetch_stats_data(ticker: str) -> dict:
    """Fetch real-time market data + indicator snapshot for a ticker."""
    indicator = StockIndicator(ticker)
    info = indicator.info or {}
    indicators = indicator.get_all_indicators()

    price = round_optional(indicators.get("price"), 2)
    if price is not None and price <= 0:
        price = None

    change = round_optional(indicators.get("change"), 2)
    change_percent = round_optional(indicators.get("change_percent"), 2)

    market_cap_raw = round_optional(indicators.get("market_cap"), 0)
    market_cap = format_market_cap(market_cap_raw)
    pe = round_optional(indicators.get("pe"), 2)
    pe_forward = round_optional(indicators.get("pe_forward"), 2)
    peg = round_optional(indicators.get("peg"), 2)
    beta = round_optional(indicators.get("beta"), 2)
    iv = round_optional(indicators.get("iv"), 2)

    one_month_change_percent = round_optional(indicators.get("one_month_change_percent"), 2)
    three_month_change_percent = round_optional(indicators.get("three_month_change_percent"), 2)
    six_month_change_percent = round_optional(indicators.get("six_month_change_percent"), 2)
    one_year_change_percent = round_optional(indicators.get("one_year_change_percent"), 2)
    mtd_change_percent = round_optional(indicators.get("mtd_change_percent"), 2)
    ytd_change_percent = round_optional(indicators.get("ytd_change_percent"), 2)

    # Backward-compatible aliases kept for older consumers.
    twenty_day_change_percent = one_month_change_percent
    fifty_day_change_percent = three_month_change_percent
    one_hundred_day_change_percent = six_month_change_percent
    two_hundred_day_change_percent = one_year_change_percent

    median_upside = round_optional(indicators.get("median_upside"), 2)
    revenue_growth = round_optional(indicators.get("revenue_growth"), 2)
    gross_margin = round_optional(indicators.get("gross_margin"), 2)
    debt_to_equity = round_optional(indicators.get("debt_to_equity"), 2)
    free_cash_flow = round_optional(indicators.get("free_cash_flow"), 0)

    return {
        "price": price,
        "current_price": price,
        "change": change,
        "change_percent": change_percent,
        "bucket": random.choice(BUCKETS),
        "name": info.get("shortName") or info.get("longName") or ticker,
        "rsi": round_optional(indicators.get("rsi"), 2),
        "one_month_change_percent": one_month_change_percent,
        "three_month_change_percent": three_month_change_percent,
        "six_month_change_percent": six_month_change_percent,
        "one_year_change_percent": one_year_change_percent,
        "mtd_change_percent": mtd_change_percent,
        "ytd_change_percent": ytd_change_percent,
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
        "beta": beta,
        "iv": iv,
        "revenue_growth": revenue_growth,
        "gross_margin": gross_margin,
        "debt_to_equity": debt_to_equity,
        "free_cash_flow": free_cash_flow,
        "_raw_info_snapshot": info,  # Kept for scoring logic
    }


def create_fallback_stats(ticker: str) -> dict:
    """Create fallback stats for failed ticker fetches."""
    return {
        "price": None,
        "current_price": None,
        "change": None,
        "change_percent": None,
        "bucket": random.choice(BUCKETS),
        "name": ticker,
        "rsi": None,
        "one_month_change_percent": None,
        "three_month_change_percent": None,
        "six_month_change_percent": None,
        "one_year_change_percent": None,
        "mtd_change_percent": None,
        "ytd_change_percent": None,
        "twenty_day_change_percent": None,
        "fifty_day_change_percent": None,
        "one_hundred_day_change_percent": None,
        "two_hundred_day_change_percent": None,
        "median_upside": None,
        "market_cap": None,
        "pe": None,
        "pe_forward": None,
        "peg": None,
        "beta": None,
        "iv": None,
        "revenue_growth": None,
        "gross_margin": None,
        "debt_to_equity": None,
        "free_cash_flow": None,
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
    trends = [
        stats.get("one_month_change_percent"),
        stats.get("three_month_change_percent"),
        stats.get("six_month_change_percent"),
        stats.get("one_year_change_percent"),
        stats.get("twenty_day_change_percent"),
        stats.get("fifty_day_change_percent"),
        stats.get("two_hundred_day_change_percent"),
    ]
    valid_trends = [v for v in trends if v is not None]
    avg_trend = sum(valid_trends) / len(valid_trends) if valid_trends else 0
    p_up = max(0.3, min(0.8, 0.55 + (avg_trend / 100.0)))
    p_down = 0.2

    # 3. Dynamic placeholders (Moat/Quality) based on proxies
    mkt_cap = stats.get("_market_cap_raw") or info.get("marketCap") or 0
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
        "market_cap_score": round(size_score, 1) if size_score else None,
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
        eval_data = eval_map[ticker]

        # Re-construct Evaluation object for the engine
        # We use the values already computed in generate_eval_entry

        # Note: evaluate_asset needs ScoredReason objects
        moat_score = eval_data.get("moat") or 5.0
        quality_score = eval_data.get("quality") or 5.0

        eval_input = Evaluation(
            score=eval_data.get("overall") or 5.0,
            reasons=["Engine proxy"],
            market_cap=eval_data.get("market_cap_score") or 5.0,
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

        allocation = PortfolioConfig.TARGET_TOTAL_EQUITY * (scores[ticker] / score_sum) if score_sum > 0 else (PortfolioConfig.TARGET_TOTAL_EQUITY / len(tickers))
        qty = round(allocation / numeric_price)
        qty = max(1, min(qty, PortfolioConfig.MAX_POSITION_QTY))

        portfolio_entries.append({"ticker": ticker, "quantity": float(qty), "delta": 0.0})

    return portfolio_entries


def _load_portfolio_tickers(path: Path) -> set[str]:
    """Load unique tickers from a `portfolio.json` file."""
    data = load_json(path, default=[])
    if not data:
        return set()

    if isinstance(data, list):
        rows = data
    elif isinstance(data, dict):
        rows = data.get("positions") or data.get("rows") or []
    else:
        rows = []

    tickers: set[str] = set()
    for row in rows:
        if isinstance(row, dict) and (ticker := row.get("ticker")):
            tickers.add(str(ticker))

    return tickers


def generate_static_data(
    *,
    prod: bool = False,
    include_portfolio: bool = False,
    prod_write_portfolio: bool = False,
):
    """Generate sample data (and optionally refresh production caches)."""

    # Default behavior: sample-only generation
    portfolio_tickers: set[str] = set()
    if include_portfolio or prod:
        portfolio_tickers = _load_portfolio_tickers(Path("data/portfolio.json"))

    all_tickers = sorted(set(SAMPLE_TICKERS) | portfolio_tickers)

    print(f"Generating data for {len(all_tickers)} tickers (Sample: {len(SAMPLE_TICKERS)}, Portfolio: {len(portfolio_tickers)})...")

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

    # Always save to ui/sample_data for frontend dev
    sample_dir = Path("ui/sample_data")

    write_json(sample_dir / "portfolio.json", portfolio_list)
    write_json(sample_dir / "stats.json", stats_map)
    write_json(sample_dir / "eval.json", eval_map)
    print(f"Saved to {sample_dir}")

    # Conditionally save to data/ for backend use
    # Note: portfolio.json is the server source of truth and is NOT overwritten unless requested.
    if prod:
        data_dir = Path("data")

        write_json(data_dir / "stats.json", stats_map)
        write_json(data_dir / "eval.json", eval_map)

        if prod_write_portfolio:
            write_json(data_dir / "portfolio.json", portfolio_list)

        print(f"Saved caches to {data_dir}")
    else:
        print("Skipping save to data/ (use --prod to save caches there)")

    print(f"SUCCESS: Generated {len(portfolio_list)} positions.")
    print(f"Stats: {len(stats_map)} entries")
    print(f"Evals: {len(eval_map)} entries")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate static data for stock search.")
    parser.add_argument(
        "--include-portfolio",
        action="store_true",
        help="Include tickers from data/portfolio.json in generated sample data",
    )
    parser.add_argument(
        "--prod",
        action="store_true",
        help="Write refreshed caches (stats/eval) to data/",
    )
    parser.add_argument(
        "--prod-write-portfolio",
        action="store_true",
        help="Also overwrite data/portfolio.json (not recommended)",
    )

    args = parser.parse_args()

    generate_static_data(
        prod=args.prod,
        include_portfolio=args.include_portfolio,
        prod_write_portfolio=args.prod_write_portfolio,
    )
