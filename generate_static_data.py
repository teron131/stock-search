from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from datetime import UTC, datetime
import json
import logging
import math
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
RSI_DEFAULT = 50.0  # legacy default; prefer None for snapshots
RSI_MAX = 100.0

# Quantity generation is score-based (see assign_quantities).
# These are only used as a fallback when we can't size a position.
QUANTITY_MIN = 5
QUANTITY_MAX = 50

TARGET_TOTAL_EQUITY = 1_000_000.0
MAX_POSITION_QTY = 500

# Anchor-Calibrated Score Targets (EVALUATION.md Section 4)
P_TARGETS = {"low": 0.85, "median": 0.65, "high": 0.25}

# Preset A — Quality-bar / Mega-cap-friendly (EVALUATION.md Section 6)
ANCHORS = {
    "market_cap": {"low": 10e9, "median": 800e9, "high": 4.5e12, "invert": False},
    "peg": {"low": 0.6, "median": 1.6, "high": 3.5, "invert": True},
    "pe_forward": {"low": 12, "median": 26, "high": 55, "invert": True},
    "margin": {"low": 60, "median": 35, "high": 10, "invert": False},
    "upside": {"low": 0.55, "median": 0.18, "high": 0.00, "invert": False},
}

# Role Weights (EVALUATION.md Section 10)
# CoreIndex = 0.35*Moat + 0.35*Quality + 0.15*Valuation + 0.10*Size + 0.05*EdgeComp
# We'll use a version that aggressively emphasizes Scale and Quality (Margin)
CORE_INDEX_WEIGHTS = {
    "size_score": 0.60,  # Dominant factor to push Mega-caps to the top
    "valuation_score": 0.10,  # Lower weight for valuation discipline
    "quality_score": 0.30,  # Emphasis on high-margin stability
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
        "_raw_info_snapshot": info,
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


def _logit(p: float) -> float:
    return math.log(p / (1 - p))


def _sigma(z: float) -> float:
    return 1 / (1 + math.exp(-z))


def calculate_logistic_score(x: float | None, anchors: dict, p_targets: dict = P_TARGETS) -> float:
    """Piecewise logistic mapping (EVALUATION.md Section 3)."""
    if x is None:
        return 5.0  # Neutral baseline

    x_l, x_m, x_h = anchors["low"], anchors["median"], anchors["high"]
    p_l, p_m, p_h = p_targets["low"], p_targets["median"], p_targets["high"]

    # Handle inversion (lower is better metrics)
    if anchors.get("invert"):
        # We swap anchors and p_targets effectively so that small x -> high score
        # The math works naturally if we just flip the logic direction
        pass

    z_m = _logit(p_m)

    # Calculate scales s_L and s_R
    s_l = (x_m - x_l) / (z_m - _logit(p_l))
    s_r = (x_h - x_m) / (_logit(p_h) - z_m)

    z = (z_m + (x - x_m) / s_l if s_l != 0 else z_m) if x <= x_m else (z_m + (x - x_m) / s_r if s_r != 0 else z_m)

    score = 10 * _sigma(z)
    return max(0.0, min(10.0, score))


def assign_quantities(rows: list[dict]) -> None:
    """Assign quantities based on Evaluation Engine scores (no new network calls)."""

    scores: dict[int, float] = {}

    for i, row in enumerate(rows):
        ticker = row["ticker"]
        # Use existing row data to avoid yfinance rate limits
        info = row.get("_raw_info_snapshot") or {}

        # 1. Calculate Scores using existing indicators/metrics
        size_score = market_cap_score(ticker, info) or 5.0
        valuation_score = calculate_valuation_score(info) or 5.0

        # Pull these from the row since they were fetched in the first pass
        m_upside = row.get("median_upside")
        upside_score = (
            calculate_combined_upside_score(
                m_upside,
                ratings=None,
                outlook_score=None,
            )
            or 5.0
        )

        # 2. Momentum proxy
        # Average of the trend percentages we have
        trends = [row.get("twenty_day_change_percent"), row.get("fifty_day_change_percent"), row.get("two_hundred_day_change_percent")]
        valid_trends = [v for v in trends if v is not None]
        avg_trend = sum(valid_trends) / len(valid_trends) if valid_trends else 0

        # Map avg trend to a 0.4 - 0.7 probability range
        p_up = max(0.3, min(0.8, 0.55 + (avg_trend / 100.0)))
        p_down = 0.2

        # 3. Dynamic placeholders for LLM fields (Moat/Quality)
        # We use Size and Margin as proxies to ensure scores aren't flat
        mkt_cap = info.get("marketCap") or 0
        margin_val = (row.get("gross_margin") or 0) / 100.0

        # Moat proxy: Scale + Ecosystem
        moat_score = 4.0
        if mkt_cap > 1e12:
            moat_score = 9.5  # Trillion club
        elif mkt_cap > 500e9:
            moat_score = 8.5  # Mega-cap
        elif mkt_cap > 100e9:
            moat_score = 7.0  # Large-cap

        # Quality proxy: Profitability + Execution
        quality_score = 4.5
        if margin_val > 0.70:
            quality_score = 9.5  # Elite (NVDA territory)
        elif margin_val > 0.40:
            quality_score = 8.0
        elif margin_val > 0.25:
            quality_score = 6.5

        # 4. Assemble Evaluation input
        eval_input = Evaluation(
            score=(moat_score + quality_score + valuation_score + upside_score) / 4,
            reasons=["Engine proxy"],
            market_cap=size_score,
            valuation=valuation_score,
            upside=upside_score,
            bull_probability=p_up,
            bear_probability=p_down,
            moat=ScoredReason(score=moat_score, reasons=["Proxy"]),
            quality=ScoredReason(score=quality_score, reasons=["Proxy"]),
        )

        # 5. Run Evaluation Result (Calculates Strategy Indices)
        res = evaluate_asset(eval_input, ticker=ticker)

        # 6. Sizing Logic: Core Index x Confidence
        # This makes the "High Conviction" stocks lead by far.
        # We use Core Index because it values Moat/Quality/Size/Value.
        base_weight = res.core_index or 1.0

        # Strategic Conviction Multiplier (AI super-cycle pillars)
        # This aligns the snapshot with Doctrine Section 7.1
        pillar_boost = 1.0
        if ticker == "NVDA":
            pillar_boost = 1.5
        elif ticker == "GOOGL":
            pillar_boost = 1.3
        elif ticker in ["MSFT", "AAPL", "AVGO", "META"]:
            pillar_boost = 1.2

        scores[i] = base_weight * pillar_boost

    score_sum = sum(scores.values())

    for i, row in enumerate(rows):
        price = row.get("current_price")
        # Ensure price is a valid numeric type for allocation
        try:
            numeric_price = float(price) if price is not None else 0.0
        except (TypeError, ValueError):
            numeric_price = 0.0

        if numeric_price <= 0:
            row["quantity"] = 0
            row["notional"] = 0
            continue

        allocation = TARGET_TOTAL_EQUITY * (scores[i] / score_sum) if score_sum > 0 else (TARGET_TOTAL_EQUITY / len(rows))
        qty = round(allocation / numeric_price)
        qty = max(1, min(qty, MAX_POSITION_QTY))

        row["quantity"] = qty
        row["notional"] = _round(qty * numeric_price, 2)

    # Note: Moat/Quality/Reasons are intentionally excluded (None) here
    # so we don't overwrite real data with dummy values.
    # remove internal-only fields
    for row in rows:
        row.pop("_market_cap_raw", None)
        row.pop("_raw_info_snapshot", None)


def calculate_portfolio_weights(rows: list[dict]) -> None:
    """Calculate and update portfolio weights in-place."""
    total_val = sum((float(r.get("notional") or 0)) for r in rows)

    for r in rows:
        notional = r.get("notional")
        if total_val > 0 and notional is not None:
            r["weight_pct"] = round((float(notional) / total_val) * 100, 2)
        else:
            r["weight_pct"] = None


def generate_portfolio_data(tickers: list[str]) -> tuple[list[dict], str]:
    """Generate portfolio data with live market prices, skipping existing tickers."""
    generated_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Load existing data to avoid re-fetching
    existing_rows = {}
    portfolio_path = Path("ui/sample_data/portfolio.json")
    if portfolio_path.exists():
        with suppress(Exception):
            data = json.loads(portfolio_path.read_text(encoding="utf-8"))
            existing_rows = {r["ticker"]: r for r in data.get("rows", [])}

    print(f"Checking data for {len(tickers)} tickers...")

    final_rows = []
    tickers_to_fetch = []

    for ticker in tickers:
        if ticker in existing_rows and "gross_margin" in existing_rows[ticker]:
            final_rows.append(existing_rows[ticker])
            continue
        tickers_to_fetch.append(ticker)

    if tickers_to_fetch:
        print(f"Fetching real-time data for {len(tickers_to_fetch)} new/incomplete tickers...")

        def safe_fetch(ticker: str) -> dict:
            try:
                return fetch_ticker_data(ticker)
            except Exception as e:
                print(f"    ! Error fetching {ticker}: {e}")
                return create_fallback_row(ticker)

        with ThreadPoolExecutor(max_workers=2) as executor:
            fetched = list(executor.map(safe_fetch, tickers_to_fetch))
            final_rows.extend(fetched)

    # Re-calculate quantities and weights over the combined set
    assign_quantities(final_rows)
    calculate_portfolio_weights(final_rows)

    return final_rows, generated_at


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
