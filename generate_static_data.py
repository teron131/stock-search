"""Generate sample or production portfolio data files from live stats."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
import logging
from pathlib import Path
import random
from types import SimpleNamespace

from stock_search.api.config import DATA_SQLITE_PATH, SAMPLE_DATA_SQLITE_PATH
from stock_search.common_utils import format_market_cap, round_optional
from stock_search.config import PortfolioConfig
from stock_search.evaluation.evaluation import evaluate_asset
from stock_search.evaluation.scores import (
    calculate_combined_upside_score,
    calculate_valuation_score,
    market_cap_score,
)
from stock_search.indicators import StockIndicator
from stock_search.models import Evaluation, ScoredReason
from stock_search.sqlite_store import SQLiteStore
from stock_search.static_demo import write_static_demo_snapshot

# Mute yfinance logging
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

BUCKETS = [
    "Core",
    "Satellite",
    "Speculation",
    "Defense",
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
    change_percent_1d = round_optional(indicators.get("change_percent_1d"), 2)

    market_cap_raw = round_optional(indicators.get("market_cap"), 0)
    market_cap = format_market_cap(market_cap_raw)
    pe = round_optional(indicators.get("pe"), 2)
    pe_forward = round_optional(indicators.get("pe_forward"), 2)
    peg = round_optional(indicators.get("peg"), 2)
    beta = round_optional(indicators.get("beta"), 2)
    iv = round_optional(indicators.get("iv"), 2)

    change_percent_1m = round_optional(indicators.get("change_percent_1m"), 2)
    change_percent_3m = round_optional(indicators.get("change_percent_3m"), 2)
    change_percent_6m = round_optional(indicators.get("change_percent_6m"), 2)
    change_percent_1y = round_optional(indicators.get("change_percent_1y"), 2)
    change_percent_mtd = round_optional(indicators.get("change_percent_mtd"), 2)
    change_percent_ytd = round_optional(indicators.get("change_percent_ytd"), 2)

    median_upside = round_optional(indicators.get("median_upside"), 2)
    revenue_growth = round_optional(indicators.get("revenue_growth"), 2)
    gross_margin = round_optional(indicators.get("gross_margin"), 2)
    debt_to_equity = round_optional(indicators.get("debt_to_equity"), 2)
    free_cash_flow = round_optional(indicators.get("free_cash_flow"), 0)

    return {
        "price": price,
        "change": change,
        "change_percent_1d": change_percent_1d,
        "strategy": random.choice(BUCKETS),
        "name": info.get("shortName") or info.get("longName") or ticker,
        "rsi": round_optional(indicators.get("rsi"), 2),
        "change_percent_1m": change_percent_1m,
        "change_percent_3m": change_percent_3m,
        "change_percent_6m": change_percent_6m,
        "change_percent_1y": change_percent_1y,
        "change_percent_mtd": change_percent_mtd,
        "change_percent_ytd": change_percent_ytd,
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
        "change": None,
        "change_percent_1d": None,
        "strategy": random.choice(BUCKETS),
        "name": ticker,
        "rsi": None,
        "change_percent_1m": None,
        "change_percent_3m": None,
        "change_percent_6m": None,
        "change_percent_1y": None,
        "change_percent_mtd": None,
        "change_percent_ytd": None,
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


def generate_eval_entry(_ticker: str, stats: dict) -> dict:
    """Generate evaluation scores for a ticker using statistical proxies."""
    info = stats.get("_raw_info_snapshot") or {}
    indicator = SimpleNamespace(
        peg=stats.get("peg"),
        pe=stats.get("pe"),
        pe_forward=stats.get("pe_forward"),
        debt_to_equity=stats.get("debt_to_equity"),
        market_cap=stats.get("_market_cap_raw") or info.get("marketCap"),
        free_cash_flow=stats.get("free_cash_flow"),
    )

    # 1. Calculate Scores using indicators/metrics
    size_score = market_cap_score(info) or 5.0
    valuation_score = calculate_valuation_score(indicator) or 5.0

    m_upside = stats.get("median_upside")
    upside_score = calculate_combined_upside_score(m_upside, ratings=None, outlook_score=None) or 5.0

    # 2. Momentum proxy (Bull Probability)
    trends = [
        stats.get("change_percent_1m"),
        stats.get("change_percent_3m"),
        stats.get("change_percent_6m"),
        stats.get("change_percent_1y"),
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
    # Note: We return a dict that matches the persisted evaluation row shape.

    # Compute overall score roughly matching the Core Index logic
    overall = (moat_score + quality_score + valuation_score + upside_score) / 4.0

    return {
        "overall_score": round(overall, 1),
        "quality_score": round(quality_score, 1),
        "valuation_score": round(valuation_score, 1),
        "moat_score": round(moat_score, 1),
        "upside_score": round(upside_score, 1),
        "market_cap_score": round(size_score, 1) if size_score else None,
        "bull_probability": round(p_up, 2),
        "bear_probability": round(p_down, 2),
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
        moat_score = eval_data.get("moat_score") or 5.0
        quality_score = eval_data.get("quality_score") or 5.0

        eval_input = Evaluation(
            score=eval_data.get("overall_score") or 5.0,
            reasons=["Engine proxy"],
            market_cap_score=eval_data.get("market_cap_score") or 5.0,
            valuation_score=eval_data.get("valuation_score") or 5.0,
            upside_score=eval_data.get("upside_score") or 5.0,
            bull_probability=eval_data.get("bull_probability"),
            bear_probability=eval_data.get("bear_probability"),
            moat_score=ScoredReason(score=moat_score, reasons=["Proxy"]),
            quality_score=ScoredReason(score=quality_score, reasons=["Proxy"]),
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
        price = stats.get("price")

        try:
            numeric_price = float(price) if price is not None else 0.0
        except (TypeError, ValueError):
            numeric_price = 0.0

        if numeric_price <= 0:
            continue

        allocation = PortfolioConfig.TARGET_TOTAL_EQUITY * (scores[ticker] / score_sum) if score_sum > 0 else (PortfolioConfig.TARGET_TOTAL_EQUITY / len(tickers))
        qty = round(allocation / numeric_price)
        qty = max(1, min(qty, PortfolioConfig.MAX_POSITION_QTY))

        portfolio_entries.append({"ticker": ticker, "quantity": float(qty)})

    return portfolio_entries


def _local_store(path: Path) -> SQLiteStore:
    """Build a SQLite store for generation flows."""
    return SQLiteStore(path)


def _load_portfolio_tickers(store: SQLiteStore) -> set[str]:
    """Load unique tickers from the configured SQLite store."""
    tickers: set[str] = set()
    for row in store.load_positions():
        if isinstance(row, dict) and (ticker := row.get("ticker")):
            tickers.add(str(ticker))

    return tickers


def generate_static_data(
    *,
    prod: bool = False,
    include_portfolio: bool = False,
    prod_write_portfolio: bool = False,
):
    """Generate sample data into SQLite stores."""

    main_store = _local_store(DATA_SQLITE_PATH)
    sample_store = _local_store(SAMPLE_DATA_SQLITE_PATH)

    portfolio_tickers: set[str] = set()
    if include_portfolio or prod:
        portfolio_tickers = _load_portfolio_tickers(main_store)

    all_tickers = sorted(set(SAMPLE_TICKERS) | portfolio_tickers)

    print(f"Generating data for {len(all_tickers)} tickers (Sample: {len(SAMPLE_TICKERS)}, Portfolio: {len(portfolio_tickers)})...")

    # 1. Fetch Stats
    stats_map = {}
    print("Fetching stats...")

    def safe_fetch(ticker: str) -> tuple[str, dict]:
        """Fetch one ticker payload without failing the whole generation run."""
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

    print("Saving SQLite stores...")

    generated_at = datetime.now(tz=UTC).isoformat()
    stock_map = {
        ticker: {
            "indicators": dict(stats_map.get(ticker) or {}),
            "evaluation": dict(eval_map.get(ticker) or {}),
            "labels": [],
        }
        for ticker in sorted(set(stats_map) | set(eval_map))
    }

    sample_store.save_stocks(stock_map)
    sample_store.save_positions(portfolio_list)
    sample_store.set_meta_value(key="stats_generated_at", value=generated_at)
    print(f"Saved sample data to {sample_store.db_path}")

    demo_paths = write_static_demo_snapshot(
        stocks_map=stock_map,
        generated_at=generated_at,
    )
    print(f"Refreshed static demo payloads from freshly generated stats/evals in {demo_paths['portfolio'].parent}")

    if prod:
        main_store.save_stocks(stock_map)
        main_store.set_meta_value(key="stats_generated_at", value=generated_at)

        if prod_write_portfolio:
            main_store.save_positions(portfolio_list)

        print(f"Saved production data to {main_store.db_path}")
    else:
        print("Skipping production database update (use --prod to save there)")

    print(f"SUCCESS: Generated {len(portfolio_list)} positions.")
    print(f"Stats: {len(stats_map)} entries")
    print(f"Evals: {len(eval_map)} entries")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate sample data for stock search.")
    parser.add_argument(
        "--include-portfolio",
        action="store_true",
        help="Include tickers from the production SQLite portfolio in generated sample data",
    )
    parser.add_argument(
        "--prod",
        action="store_true",
        help="Write refreshed stats and eval data to the production SQLite database",
    )
    parser.add_argument(
        "--prod-write-portfolio",
        action="store_true",
        help="Also overwrite production portfolio positions in SQLite",
    )

    args = parser.parse_args()

    generate_static_data(
        prod=args.prod,
        include_portfolio=args.include_portfolio,
        prod_write_portfolio=args.prod_write_portfolio,
    )
