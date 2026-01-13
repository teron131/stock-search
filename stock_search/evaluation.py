from dataclasses import dataclass
import math
import os
from typing import Any

from pydantic import BaseModel
import yfinance as yf

from .indicators import StockIndicator
from .llm.agents import WebSearchAgent
from .schema import Evaluation, FutureOutlook, ResearchEvaluation
from .utils import parse_query

# --- Constants ---

# Market cap configuration
B = 1e9
T = 1e12
MARKET_CAP_MIN = 10 * B
MARKET_CAP_MEDIAN = 800 * B
MARKET_CAP_MAX = 4.5 * T

# Calibration Ranges (min, median, max)
PEG_RANGE = (0.5, 1.5, 3.0)
PE_RANGE = (10.0, 28.0, 50.0)
GROWTH_RANGE = (0.1, 0.3, 0.5)
UPSIDE_RANGE = (0.0, 15.0, 50.0)
PROB_RANGE = (0.5, 0.55, 0.6)
RATING_RANGE = (1.0, 3.5, 5.0)

# Valuation weights
PEG_WEIGHT = 0.55
PE_WEIGHT = 0.2
PE_FORWARD_WEIGHT = 0.15
GROWTH_WEIGHT = 0.1

# Index calculation weights: Core Engine
CORE_MOAT_WEIGHT = 0.35
CORE_QUALITY_WEIGHT = 0.35
CORE_VALUATION_WEIGHT = 0.15
CORE_SIZE_WEIGHT = 0.10
CORE_EDGE_WEIGHT = 0.05

# Index calculation weights: Core Satellite
SATELLITE_MOAT_WEIGHT = 0.30
SATELLITE_QUALITY_WEIGHT = 0.25
SATELLITE_UPSIDE_WEIGHT = 0.25
SATELLITE_VALUATION_WEIGHT = 0.10
SATELLITE_EDGE_WEIGHT = 0.10

# Index calculation weights: Speculative (Inverse metrics used for some)
SPECULATIVE_UPSIDE_WEIGHT = 0.45
SPECULATIVE_QUALITY_INVERSE_WEIGHT = 0.20
SPECULATIVE_MOAT_INVERSE_WEIGHT = 0.20
SPECULATIVE_VALUATION_INVERSE_WEIGHT = 0.15

# Index calculation weights: Diversifier
DIVERSIFIER_QUALITY_WEIGHT = 0.45
DIVERSIFIER_VALUATION_WEIGHT = 0.25
DIVERSIFIER_SIZE_WEIGHT = 0.20
DIVERSIFIER_UPSIDE_INVERSE_WEIGHT = 0.10

# Thresholds & Misc
UPSIDE_MAX_PCT = 50
FOMO_VALUATION_THRESHOLD = 3.0
FOMO_UPSIDE_THRESHOLD = 8.0
FOMO_BULL_THRESHOLD = 5.8
WEB_SEARCH_MAX_RESULTS = 15
DIRECTION_CHANGE_DIVISOR = 10
DIRECTION_BASE_SCORE = 5.0

# Game Tier Thresholds
TIER_RARE_DISLOCATION = 6.8
TIER_SMURFING_MIN = 6.3
TIER_SMURFING_MAX = 6.7
TIER_VERY_HIGH_MIN = 5.9
TIER_VERY_HIGH_MAX = 6.2
TIER_HIGH_EDGE_MIN = 5.5
TIER_HIGH_EDGE_MAX = 5.8

# LLM Prompts
MOAT_DEFINITION = """Moat (0-10): replaceability under constraints.
How hard is it for a capable competitor (or customer) to replicate, displace, or route around this in the real world?
Barriers include switching costs / lock-in; regulatory + security + procurement barriers; integration depth + operational
workflow embedding; ecosystem/tooling gravity; and unique supply-chain/physics constraints (ASML-style).
Note: commodity does not always mean 0; consider rarity or supply constraints."""

QUALITY_DEFINITION = """Quality (0-10): ability to turn advantage into durable economics.
Profitability belongs here along with resilience. Consider margins / FCF durability across cycles,
pricing power & customer retention, operating discipline, and delivery reliability."""

RESEARCH_DEFINITION = f"Evaluate the company's Moat and Quality on a 0-10 scale.\n{MOAT_DEFINITION}\n{QUALITY_DEFINITION}"

FUTURE_OUTLOOK_DEFINITION = """Future outlook (0-10): based on foreseeable company guidance and credible near-term signals.
Score how strong the forward setup looks over ~12 months. Estimate bull/bear probabilities (0-1) for up/down in 12 months.
Reason should be a short bullet list."""


@dataclass(frozen=True)
class EvaluationResult:
    inputs: Evaluation
    ticker: str | None
    p_up: float | None
    p_down: float | None
    p_flat: float | None
    edge: float | None
    confidence: float | None
    overall: float | None
    elo_delta: float | None
    elo_delta_dir: float | None
    elo_delta_exp: float | None
    core_index: float | None
    satellite_index: float | None
    speculative_index: float | None
    diversifier_index: float | None
    fomo_flag: bool
    game_tier: str


# --- Primary Entry Points ---


def build_inputs(ticker: str) -> Evaluation:
    """Fetch metrics and run LLM evaluations to build the Evaluation input model."""
    normalized = _normalize_yahoo_ticker(ticker)
    indicator = StockIndicator(normalized)

    # 1. Qualitative Evaluation (LLM)
    outlook: FutureOutlook = _run_llm_evaluation(ticker, FUTURE_OUTLOOK_DEFINITION, FutureOutlook)
    research: ResearchEvaluation = _run_llm_evaluation(ticker, RESEARCH_DEFINITION, ResearchEvaluation)

    # 2. Market Metrics
    size_score = market_cap_score(normalized, indicator.info)
    valuation_score = _calculate_valuation_score(indicator.info)
    upside_score = _calculate_combined_upside_score(indicator.median_upside, indicator.ratings, outlook.score if outlook else None)

    # 3. Probability Modeling
    bull_score, bear_score = _model_probabilities(indicator, outlook)

    p_up = round(bull_score / 10.0, 4) if bull_score is not None else None
    p_down = round(bear_score / 10.0, 4) if bear_score is not None else None

    # Calculate flat probability
    p_flat = None
    if p_up is not None and p_down is not None:
        p_flat = max(0.0, round(1.0 - p_up - p_down, 4))

    # 4. Input Assembly
    eval_data = {
        "valuation": valuation_score,
        "upside": upside_score,
        "market_cap": float(size_score) if size_score is not None else None,
        "bull_probability": p_up,
        "bear_probability": p_down,
        "flat_probability": p_flat,
    }

    if outlook:
        eval_data.update(outlook.model_dump(exclude={"bull_probability", "bear_probability"}))
    if research:
        eval_data.update(research.model_dump())

    return Evaluation(**eval_data)


def evaluate_asset(inputs: Evaluation, ticker: str | None = None) -> EvaluationResult:
    """Process an Evaluation model into a final EvaluationResult with indices and deltas."""
    p_up = inputs.bull_probability
    p_down = inputs.bear_probability
    p_flat = inputs.flat_probability
    if p_flat is None and p_up is not None and p_down is not None:
        p_flat = max(0.0, 1 - p_up - p_down)

    bull_score = p_up * 10.0 if p_up is not None else None
    bear_score = p_down * 10.0 if p_down is not None else None
    edge = bull_score - bear_score if bull_score is not None and bear_score is not None else None

    scores = {
        "moat": inputs.moat.score if inputs.moat else None,
        "quality": inputs.quality.score if inputs.quality else None,
        "valuation": inputs.valuation,
        "upside": inputs.upside,
        "size": inputs.market_cap,
    }

    # Core 4-metric average
    req = (scores["moat"], scores["quality"], scores["valuation"], scores["upside"])
    overall = sum(req) / 4 if all(v is not None for v in req) else None

    indices = _calculate_strategy_indices(scores, edge)
    fomo_flag = _check_fomo_conditions(scores, bull_score)

    return EvaluationResult(
        inputs=inputs,
        ticker=ticker,
        p_up=p_up,
        p_down=p_down,
        p_flat=p_flat,
        edge=edge,
        confidence=abs(edge) if edge is not None else None,
        overall=overall,
        elo_delta=_calculate_elo_delta(p_up),
        elo_delta_dir=400 * math.log10(p_up / p_down) if p_up is not None and p_down is not None and p_up > 0 and p_down > 0 else None,
        elo_delta_exp=_calculate_elo_delta(p_up + 0.5 * p_flat) if p_up is not None and p_flat is not None else None,
        core_index=indices.get("core"),
        satellite_index=indices.get("satellite"),
        speculative_index=indices.get("speculative"),
        diversifier_index=indices.get("diversifier"),
        fomo_flag=fomo_flag,
        game_tier=_get_game_tier(bull_score),
    )


# --- Utility: Mapping & Scoring ---


def clamp_score(value: float) -> float:
    """Clamp score to valid range [0, 10] and round to 2 decimals."""
    if value < 0.0:
        return 0.0
    if value > 10.0:
        return 10.0
    return round(value, 2)


def piecewise_map(
    value: float,
    in_min: float,
    in_max: float,
    in_median: float,
    out_min: float = 0.0,
    out_max: float = 10.0,
    out_median: float = 5.0,
) -> float:
    """Map a value through two linear stages (min->median, median->max)."""
    if value <= in_min:
        return out_min
    if value >= in_max:
        return out_max

    if value <= in_median:
        if in_median == in_min:
            return out_median
        ratio = (value - in_min) / (in_median - in_min)
        return clamp_score(out_min + ratio * (out_median - out_min))
    else:
        if in_max == in_median:
            return out_max
        ratio = (value - in_median) / (in_max - in_median)
        return clamp_score(out_median + ratio * (out_max - out_median))


def z_score_map(
    value: float,
    in_min: float,
    in_max: float,
    in_median: float,
    out_min: float = 0.0,
    out_max: float = 10.0,
) -> float:
    """Map a value using a Normal CDF (S-curve) based on piecewise Z-scores."""
    if value <= in_min:
        return out_min
    if value >= in_max:
        return out_max

    # 1 sigma = 1/3 distance to median
    sigma = ((in_median - in_min) if value <= in_median else (in_max - in_median)) / 3.0
    z = (value - in_median) / sigma if sigma > 0 else 0

    phi = 0.5 * (1 + math.erf(z / math.sqrt(2)))
    return clamp_score(out_min + (out_max - out_min) * phi)


# --- Internal Scoring Helpers ---


def market_cap_score(ticker: str, info: dict | None = None) -> float | None:
    """Map market cap to 1-10 using a Log-S-curve."""
    info = info or (yf.Ticker(_normalize_yahoo_ticker(ticker)).info or {})
    mcap = info.get("marketCap")
    if info.get("quoteType") == "ETF" or not mcap:
        return None

    return z_score_map(math.log10(mcap), in_min=math.log10(MARKET_CAP_MIN), in_median=math.log10(MARKET_CAP_MEDIAN), in_max=math.log10(MARKET_CAP_MAX))


def _calculate_valuation_score(info: dict) -> float | None:
    """Compute weighted valuation score from PEG, PE, and Growth."""
    configs = [
        ("trailingPegRatio", PEG_RANGE, PEG_WEIGHT, True),  # True = inverse
        ("trailingPE", PE_RANGE, PE_WEIGHT, True),
        ("forwardPE", PE_RANGE, PE_FORWARD_WEIGHT, True),
        ("earningsGrowth", GROWTH_RANGE, GROWTH_WEIGHT, False),
    ]

    weighted_scores = []
    total_w = 0.0

    for key, range_val, weight, inverse in configs:
        if (val := info.get(key)) is not None:
            i_min, i_med, i_max = range_val
            score = piecewise_map(val, in_min=i_min, in_max=i_max, in_median=i_med, out_min=10.0 if inverse else 0.0, out_max=0.0 if inverse else 10.0, out_median=5.0)
            weighted_scores.append(score * weight)
            total_w += weight

    return clamp_score(sum(weighted_scores) / total_w) if total_w > 0 else None


def _calculate_combined_upside_score(median_upside: float | None, ratings: list[dict] | None, outlook_score: float | None) -> float | None:
    """Blend analyst upside, current ratings, and LLM outlook into a single score."""
    i_min, i_med, i_max = UPSIDE_RANGE
    u_score = None
    if median_upside is not None:
        u_score = piecewise_map(median_upside, in_min=i_min, in_max=i_max, in_median=i_med)

    r_score = _calculate_rating_score(ratings)

    values = [v for v in (u_score, r_score, outlook_score) if v is not None]
    return clamp_score(sum(values) / len(values)) if values else None


def _calculate_rating_score(ratings: list[dict] | None) -> float | None:
    """Map list of analyst ratings to 0-10 engine score."""
    if not ratings:
        return None

    scores = []
    for r in ratings:
        grade = r.get("toGrade") or r.get("rating") or r.get("grade")
        if isinstance(grade, str):
            val = _parse_rating_grade(grade)
            if val is not None:
                scores.append(val)

    if not scores:
        return None

    i_min, i_med, i_max = RATING_RANGE
    return piecewise_map(sum(scores) / len(scores), in_min=i_min, in_max=i_max, in_median=i_med)


def _parse_rating_grade(text: str) -> float | None:
    """Parse common rating strings to 1-5 scale."""
    text = text.lower()
    mapping = {
        "strong buy": 5.0,
        "buy": 4.5,
        "overweight": 4.0,
        "outperform": 4.0,
        "hold": 3.5,
        "neutral": 3.5,
        "underperform": 2.5,
        "underweight": 2.5,
        "sell": 1.0,
    }
    if "strong" in text and "buy" in text:
        return 5.0
    for kw, val in mapping.items():
        if kw in text:
            return val
    return None


def _model_probabilities(indicator: StockIndicator, outlook: FutureOutlook | None) -> tuple[float | None, float | None]:
    """Derive calibrated bull/bear scores from LLM or Historical momentum."""
    p_min, p_med, p_max = PROB_RANGE

    if outlook and outlook.bull_probability is not None and outlook.bear_probability is not None:
        return (piecewise_map(outlook.bull_probability, p_min, p_max, p_med), piecewise_map(outlook.bear_probability, p_min, p_max, p_med))

    # Momentum fallback
    b_raw, r_raw = _calculate_historical_momentum_scores(indicator)
    if b_raw is None or r_raw is None:
        return None, None

    return (piecewise_map(b_raw / 10.0, p_min, p_max, p_med), piecewise_map(r_raw / 10.0, p_min, p_max, p_med))


def _calculate_historical_momentum_scores(indicator: StockIndicator) -> tuple[float | None, float | None]:
    """Average recent price changes into a 0-10 momentum score."""
    changes = [indicator.change_percent, indicator.twenty_day_change_percent, indicator.fifty_day_change_percent, indicator.two_hundred_day_change_percent]
    valid = [v for v in changes if isinstance(v, (int, float))]
    if not valid:
        return None, None

    avg = sum(valid) / len(valid)
    return (clamp_score(DIRECTION_BASE_SCORE + avg / DIRECTION_CHANGE_DIVISOR), clamp_score(DIRECTION_BASE_SCORE - avg / DIRECTION_CHANGE_DIVISOR))


def _calculate_strategy_indices(scores: dict[str, float | None], edge: float | None) -> dict[str, float | None]:
    """Apply strategy weights to core scores to find suitable portfolio buckets."""
    edge_comp = (5.0 + 0.5 * edge) if edge is not None else None

    bucket_configs = {
        "core": {
            "keys": ("moat", "quality", "valuation", "size"),
            "weights": (CORE_MOAT_WEIGHT, CORE_QUALITY_WEIGHT, CORE_VALUATION_WEIGHT, CORE_SIZE_WEIGHT),
            "edge": CORE_EDGE_WEIGHT,
        },
        "satellite": {
            "keys": ("moat", "quality", "valuation", "upside"),
            "weights": (SATELLITE_MOAT_WEIGHT, SATELLITE_QUALITY_WEIGHT, SATELLITE_VALUATION_WEIGHT, SATELLITE_UPSIDE_WEIGHT),
            "edge": SATELLITE_EDGE_WEIGHT,
        },
        "speculative": {
            "keys": ("moat", "quality", "valuation", "upside"),
            "weights": (SPECULATIVE_MOAT_INVERSE_WEIGHT, SPECULATIVE_QUALITY_INVERSE_WEIGHT, SPECULATIVE_VALUATION_INVERSE_WEIGHT, SPECULATIVE_UPSIDE_WEIGHT),
            "edge": 0.0,
        },
        "diversifier": {
            "keys": ("quality", "valuation", "size", "upside"),
            "weights": (DIVERSIFIER_QUALITY_WEIGHT, DIVERSIFIER_VALUATION_WEIGHT, DIVERSIFIER_SIZE_WEIGHT, DIVERSIFIER_UPSIDE_INVERSE_WEIGHT),
            "edge": 0.0,
        },
    }

    indices = {}
    for name, cfg in bucket_configs.items():
        vals = [scores[k] for k in cfg["keys"]]
        if all(v is not None for v in vals) and (cfg["edge"] == 0 or edge_comp is not None):
            weighted = sum(v * w for v, w in zip(vals, cfg["weights"], strict=False))
            indices[name] = weighted + (cfg["edge"] * (edge_comp or 0))
        else:
            indices[name] = None
    return indices


# --- Private Misc Helpers ---


def _run_llm_evaluation(ticker: str, system_prompt: str, response_format: type[BaseModel]) -> Any:
    """Execute structured LLM search/analysis for a specific ticker."""
    model = os.getenv("QUALITY_LLM")
    if not model:
        return None

    agent = WebSearchAgent(
        model=model, temperature=0, reasoning_effort="high", response_format=response_format, system_prompt=system_prompt, web_search_max_results=WEB_SEARCH_MAX_RESULTS
    )
    return agent.invoke(f"Ticker: {ticker}. Name:{parse_query(ticker)}.")


def _check_fomo_conditions(scores: dict, bull_score: float | None) -> bool:
    """Return True if an asset looks like a 'chase' opportunity."""
    v, u = scores.get("valuation"), scores.get("upside")
    if v is None or u is None or bull_score is None:
        return False
    return v <= FOMO_VALUATION_THRESHOLD and u >= FOMO_UPSIDE_THRESHOLD and bull_score <= FOMO_BULL_THRESHOLD


def _calculate_elo_delta(p: float | None) -> float | None:
    """Calculate Elo delta based on success probability."""
    if p is None or not (0 < p < 1):
        return None
    return 400 * math.log10(p / (1 - p))


def _get_game_tier(bull: float | None) -> str:
    """Categorize the 'edge' level of the setup."""
    if bull is None:
        return "normal"
    if bull >= TIER_RARE_DISLOCATION:
        return "rare dislocation-level"
    if TIER_SMURFING_MIN <= bull <= TIER_SMURFING_MAX:
        return "smurfing"
    if TIER_VERY_HIGH_MIN <= bull <= TIER_VERY_HIGH_MAX:
        return "very high"
    if TIER_HIGH_EDGE_MIN <= bull <= TIER_HIGH_EDGE_MAX:
        return "already high edge"
    return "normal"


def _normalize_yahoo_ticker(ticker: str) -> str:
    """Normalize common ticker variants for Yahoo Finance compatibility."""
    return ticker.replace(" ", "-").replace(".", "-")
