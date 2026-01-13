from dataclasses import dataclass
import math
import os

from pydantic import BaseModel, Field
import yfinance as yf

from .indicators import StockIndicator
from .llm.agents import WebSearchAgent
from .schema import Evaluation
from .utils import parse_query

# Market cap constants
BILLION = 1e9
TRILLION = 1e12
MARKET_CAP_MIN = 10 * BILLION
MARKET_CAP_MAX_FALLBACK = 4.5 * TRILLION

# Scoring constants
UPSIDE_MAX_PCT = 50
DEFAULT_PROBABILITY = 0.0

# LLM configuration
QUALITY_MODEL_ENV = "QUALITY_MODEL"
WEB_SEARCH_MAX_RESULTS = 15

# Valuation scoring thresholds
PEG_EXCELLENT = 0.8
PEG_GOOD = 1.0
PEG_FAIR = 1.5
PEG_MODERATE = 2.0
PEG_POOR = 3.0

PE_EXCELLENT = 12
PE_GOOD = 18
PE_FAIR = 25
PE_MODERATE = 35

GROWTH_EXCELLENT = 0.3
GROWTH_GOOD = 0.2
GROWTH_FAIR = 0.1
GROWTH_MODERATE = 0.05

# Valuation weights
PEG_WEIGHT = 0.55
PE_WEIGHT = 0.2
PE_FORWARD_WEIGHT = 0.15
GROWTH_WEIGHT = 0.1

# Index calculation weights
CORE_MOAT_WEIGHT = 0.35
CORE_QUALITY_WEIGHT = 0.35
CORE_VALUATION_WEIGHT = 0.15
CORE_SIZE_WEIGHT = 0.10
CORE_EDGE_WEIGHT = 0.05

SATELLITE_MOAT_WEIGHT = 0.30
SATELLITE_QUALITY_WEIGHT = 0.25
SATELLITE_UPSIDE_WEIGHT = 0.25
SATELLITE_VALUATION_WEIGHT = 0.10
SATELLITE_EDGE_WEIGHT = 0.10

SPECULATIVE_UPSIDE_WEIGHT = 0.45
SPECULATIVE_QUALITY_INVERSE_WEIGHT = 0.20
SPECULATIVE_MOAT_INVERSE_WEIGHT = 0.20
SPECULATIVE_VALUATION_INVERSE_WEIGHT = 0.15

DIVERSIFIER_QUALITY_WEIGHT = 0.45
DIVERSIFIER_VALUATION_WEIGHT = 0.25
DIVERSIFIER_SIZE_WEIGHT = 0.20
DIVERSIFIER_UPSIDE_INVERSE_WEIGHT = 0.10

# FOMO flag thresholds
FOMO_VALUATION_THRESHOLD = 3.0
FOMO_UPSIDE_THRESHOLD = 8.0
FOMO_BULL_THRESHOLD = 5.8

# Game tier thresholds
TIER_RARE_DISLOCATION = 6.8
TIER_SMURFING_MIN = 6.3
TIER_SMURFING_MAX = 6.7
TIER_VERY_HIGH_MIN = 5.9
TIER_VERY_HIGH_MAX = 6.2
TIER_HIGH_EDGE_MIN = 5.5
TIER_HIGH_EDGE_MAX = 5.8

# Direction scoring
DIRECTION_CHANGE_DIVISOR = 10
DIRECTION_BASE_SCORE = 5.0

MOAT_DEFINITION = """Moat (0-10): replaceability under constraints.
How hard is it for a capable competitor (or customer) to replicate, displace, or route around this in the real world?
Barriers include switching costs / lock-in; regulatory + security + procurement barriers; integration depth + operational
workflow embedding; ecosystem/tooling gravity; and unique supply-chain/physics constraints (ASML-style).
Note: commodity does not always mean 0; consider rarity or supply constraints."""

QUALITY_DEFINITION = """Quality (0-10): ability to turn advantage into durable economics.
Profitability belongs here along with resilience. Consider margins / FCF durability across cycles,
pricing power & customer retention, operating discipline, and delivery reliability."""

FUTURE_OUTLOOK_DEFINITION = """Future outlook (0-10): based on foreseeable company guidance and credible near-term signals.
Score how strong the forward setup looks over ~12 months. Estimate bull/bear probabilities (0-1) for up/down in 12 months.
Reason should be a short bullet list."""


class ScoredReason(BaseModel):
    score: float = Field(description="Score on a 0-10 scale.", ge=0, le=10)
    reason: str = Field(description="Bullet list string explaining the score.")


class FutureOutlook(BaseModel):
    score: float = Field(description="Score on a 0-10 scale.", ge=0, le=10)
    bull_probability: float = Field(description="Bull probability (0-1) for 12-month up move.", ge=0, le=1)
    bear_probability: float = Field(description="Bear probability (0-1) for 12-month down move.", ge=0, le=1)
    reason: str = Field(description="Bullet list string explaining the outlook.")


@dataclass(frozen=True)
class EvaluationResult:
    inputs: Evaluation
    ticker: str | None
    p_up: float
    p_down: float
    p_flat: float
    edge: float
    confidence: float
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


def build_inputs(ticker: str) -> Evaluation:
    """Create evaluation inputs from available indicator metrics."""
    normalized = _normalize_yahoo_ticker(ticker)
    indicator = StockIndicator(normalized)

    size_score = market_cap_score(normalized, indicator.info)
    outlook = _run_llm_evaluation(ticker, FUTURE_OUTLOOK_DEFINITION, FutureOutlook)

    quality_def = f"Use web search to score a company on a 0-10 scale. {QUALITY_DEFINITION}"
    quality_resp = _run_llm_evaluation(ticker, quality_def, ScoredReason)
    quality_score = _clamp_score(quality_resp.score) if quality_resp else None

    valuation_score = _valuation_score(indicator.info)
    upside_score = _upside_score(
        indicator.median_upside,
        indicator.ratings,
        outlook.score if outlook else None,
    )

    moat_def = f"Use web search to score a company on a 0-10 scale. {MOAT_DEFINITION}"
    moat_resp = _run_llm_evaluation(ticker, moat_def, ScoredReason)
    moat_score = _clamp_score(moat_resp.score) if moat_resp else None

    if outlook and outlook.bull_probability is not None and outlook.bear_probability is not None:
        bull_score = _clamp_score(outlook.bull_probability * 10.0)
        bear_score = _clamp_score(outlook.bear_probability * 10.0)
    else:
        bull_score, bear_score = _direction_scores(
            indicator.change_percent,
            indicator.twenty_day_change_percent,
            indicator.fifty_day_change_percent,
            indicator.two_hundred_day_change_percent,
        )

    return Evaluation(
        moat=moat_score,
        quality=quality_score,
        valuation=valuation_score,
        upside=upside_score,
        market_cap=float(size_score) if size_score is not None else None,
        bull_probability=round(bull_score / 10.0, 4) if bull_score is not None else None,
        bear_probability=round(bear_score / 10.0, 4) if bear_score is not None else None,
    )


def evaluate_asset(inputs: Evaluation, ticker: str | None = None) -> EvaluationResult:
    """Compute evaluation metrics for a single asset.

    Args:
        inputs: Core scores on a 1-10 scale and direction probabilities on a 0-1 scale.
        ticker: Optional ticker symbol for the asset.

    Returns:
        EvaluationResult with derived probabilities, Elo deltas, and indices.
    """
    p_up = inputs.bull_probability if inputs.bull_probability is not None else DEFAULT_PROBABILITY
    p_down = inputs.bear_probability if inputs.bear_probability is not None else DEFAULT_PROBABILITY
    p_flat = max(0.0, 1 - p_up - p_down)

    bull_score = p_up * 10.0
    bear_score = p_down * 10.0
    edge = bull_score - bear_score
    confidence = abs(edge)

    scores = {
        "moat": inputs.moat,
        "quality": inputs.quality,
        "valuation": inputs.valuation,
        "upside": inputs.upside,
        "size": inputs.market_cap,
    }

    req = (scores["moat"], scores["quality"], scores["valuation"], scores["upside"])
    overall = sum(req) / 4 if all(v is not None for v in req) else None

    # Elo metrics
    expected = p_up + 0.5 * p_flat
    elo_delta = _elo_delta(p_up)
    elo_delta_dir = 400 * math.log10(p_up / p_down) if p_up > 0 and p_down > 0 else None
    elo_delta_exp = _elo_delta(expected)

    indices = _calculate_indices(scores, edge)

    fomo_flag = (
        scores["valuation"] <= FOMO_VALUATION_THRESHOLD and scores["upside"] >= FOMO_UPSIDE_THRESHOLD and bull_score <= FOMO_BULL_THRESHOLD
        if scores["valuation"] is not None and scores["upside"] is not None
        else False
    )
    game_tier = _game_tier(bull_score)

    return EvaluationResult(
        inputs=inputs,
        ticker=ticker,
        p_up=p_up,
        p_down=p_down,
        p_flat=p_flat,
        edge=edge,
        confidence=confidence,
        overall=overall,
        elo_delta=elo_delta,
        elo_delta_dir=elo_delta_dir,
        elo_delta_exp=elo_delta_exp,
        core_index=indices["core"],
        satellite_index=indices["satellite"],
        speculative_index=indices["speculative"],
        diversifier_index=indices["diversifier"],
        fomo_flag=fomo_flag,
        game_tier=game_tier,
    )


def _calculate_indices(scores: dict[str, float | None], edge: float) -> dict[str, float | None]:
    """Calculate all portfolio strategy indices."""
    edge_component = 5.0 + 0.5 * edge

    core_required = (scores["moat"], scores["quality"], scores["valuation"], scores["size"])
    satellite_required = (scores["moat"], scores["quality"], scores["valuation"], scores["upside"])
    speculative_required = (scores["upside"], scores["quality"], scores["moat"], scores["valuation"])
    diversifier_required = (scores["quality"], scores["valuation"], scores["size"], scores["upside"])

    indices = {
        "core": (
            CORE_MOAT_WEIGHT * scores["moat"]
            + CORE_QUALITY_WEIGHT * scores["quality"]
            + CORE_VALUATION_WEIGHT * scores["valuation"]
            + CORE_SIZE_WEIGHT * scores["size"]
            + CORE_EDGE_WEIGHT * edge_component
            if all(value is not None for value in core_required)
            else None
        ),
        "satellite": (
            SATELLITE_MOAT_WEIGHT * scores["moat"]
            + SATELLITE_QUALITY_WEIGHT * scores["quality"]
            + SATELLITE_UPSIDE_WEIGHT * scores["upside"]
            + SATELLITE_VALUATION_WEIGHT * scores["valuation"]
            + SATELLITE_EDGE_WEIGHT * edge_component
            if all(value is not None for value in satellite_required)
            else None
        ),
        "speculative": (
            SPECULATIVE_UPSIDE_WEIGHT * scores["upside"]
            + SPECULATIVE_QUALITY_INVERSE_WEIGHT * scores["quality"]
            + SPECULATIVE_MOAT_INVERSE_WEIGHT * scores["moat"]
            + SPECULATIVE_VALUATION_INVERSE_WEIGHT * scores["valuation"]
            if all(value is not None for value in speculative_required)
            else None
        ),
        "diversifier": (
            DIVERSIFIER_QUALITY_WEIGHT * scores["quality"]
            + DIVERSIFIER_VALUATION_WEIGHT * scores["valuation"]
            + DIVERSIFIER_SIZE_WEIGHT * scores["size"]
            + DIVERSIFIER_UPSIDE_INVERSE_WEIGHT * scores["upside"]
            if all(value is not None for value in diversifier_required)
            else None
        ),
    }

    return indices


def _create_llm_agent(
    system_prompt: str,
    response_format: type[BaseModel],
    model: str | None = None,
) -> WebSearchAgent | None:
    """Create a WebSearchAgent with the given configuration."""
    model = model or os.getenv(QUALITY_MODEL_ENV)
    if not model:
        return None
    return WebSearchAgent(
        model=model,
        temperature=0,
        reasoning_effort="high",
        response_format=response_format,
        system_prompt=system_prompt,
        web_search_max_results=WEB_SEARCH_MAX_RESULTS,
    )


def _run_llm_evaluation(
    ticker: str,
    definition: str,
    response_format: type[BaseModel],
) -> BaseModel | None:
    """Helper to run an LLM evaluation for a ticker."""
    agent = _create_llm_agent(definition, response_format)
    if not agent:
        return None
    company_name = parse_query(ticker)
    response = agent.invoke(f"Ticker: {ticker}. Name:{company_name}.")
    if not isinstance(response, response_format):
        return None
    return response


def market_cap_score(ticker: str, info: dict | None = None) -> float | None:
    """Map Yahoo market cap to a 1-10 score using log-linear scaling."""
    normalized = _normalize_yahoo_ticker(ticker)
    info = info or (yf.Ticker(normalized).info or {})
    if info.get("quoteType") == "ETF":
        return None

    market_cap = info.get("marketCap")
    if not market_cap:
        return None

    # Use NVDA as a benchmark for the top end of the market cap scale
    max_cap = yf.Ticker("NVDA").info.get("marketCap") or MARKET_CAP_MAX_FALLBACK
    return _log_scale_score(market_cap, MARKET_CAP_MIN, max_cap)


def _log_scale_score(value: float, min_val: float, max_val: float) -> float:
    """Calculate a 0-10 score using log-linear scaling."""
    if value <= min_val:
        return 0.0
    if value >= max_val:
        return 10.0

    log_val = math.log10(value)
    log_min = math.log10(min_val)
    log_max = math.log10(max_val)

    score = 10.0 * (log_val - log_min) / (log_max - log_min)
    return _clamp_score(score)


def _valuation_score(info: dict) -> float | None:
    """Calculate weighted valuation score from PEG, PE, and growth metrics."""
    metrics = [
        ("trailingPegRatio", _peg_score, PEG_WEIGHT),
        ("trailingPE", _pe_score, PE_WEIGHT),
        ("forwardPE", _pe_score, PE_FORWARD_WEIGHT),
        ("earningsGrowth", _growth_score, GROWTH_WEIGHT),
    ]

    scores: list[tuple[float, float]] = []
    for key, scorer, weight in metrics:
        if (val := info.get(key)) is not None:
            scores.append((scorer(val), weight))

    if not scores:
        return None

    weight_total = sum(weight for _, weight in scores)
    weighted_avg = sum(score * weight for score, weight in scores) / weight_total
    return _clamp_score(weighted_avg)


def _upside_score(
    median_upside: float | None,
    ratings: list[dict] | None,
    outlook_score: float | None,
) -> float | None:
    """Calculate upside score from median upside, ratings, and outlook."""
    upside_score = _calculate_median_upside_score(median_upside)
    rating_score = _rating_score(ratings)

    values = [value for value in (upside_score, rating_score, outlook_score) if value is not None]
    if not values:
        return None
    return _clamp_score(sum(values) / len(values))


def _calculate_median_upside_score(median_upside: float | None) -> float | None:
    """Convert median upside percentage to 0-10 score."""
    if median_upside is None:
        return None
    if median_upside <= 0:
        return 0.0
    if median_upside >= UPSIDE_MAX_PCT:
        return 10.0
    return _clamp_score((median_upside / UPSIDE_MAX_PCT) * 10.0)


def _direction_scores(*changes: float | None) -> tuple[float | None, float | None]:
    """Calculate bull/bear scores from price change percentages."""
    valid = [value for value in changes if isinstance(value, (int, float))]
    if not valid:
        return None, None
    average_change = sum(valid) / len(valid)
    bull_score = _clamp_score(DIRECTION_BASE_SCORE + average_change / DIRECTION_CHANGE_DIVISOR)
    bear_score = _clamp_score(DIRECTION_BASE_SCORE - average_change / DIRECTION_CHANGE_DIVISOR)
    return bull_score, bear_score


def _elo_delta(p_up: float) -> float | None:
    if p_up <= 0 or p_up >= 1:
        return None
    return 400 * math.log10(p_up / (1 - p_up))


def _game_tier(bull: float) -> str:
    """Determine game tier based on bull score."""
    if bull >= TIER_RARE_DISLOCATION:
        return "rare dislocation-level"
    if TIER_SMURFING_MIN <= bull <= TIER_SMURFING_MAX:
        return "smurfing"
    if TIER_VERY_HIGH_MIN <= bull <= TIER_VERY_HIGH_MAX:
        return "very high"
    if TIER_HIGH_EDGE_MIN <= bull <= TIER_HIGH_EDGE_MAX:
        return "already high edge"
    return "normal"


def _clamp_score(value: float) -> float:
    """Clamp score to valid range [0, 10] and round to 2 decimals."""
    if value < 0.0:
        return 0.0
    if value > 10.0:
        return 10.0
    return round(value, 2)


def _peg_score(peg: float) -> float:
    """Score PEG ratio (lower is better)."""
    if peg <= PEG_EXCELLENT:
        return 10.0
    if peg <= PEG_GOOD:
        return 9.0
    if peg <= PEG_FAIR:
        return 7.0
    if peg <= PEG_MODERATE:
        return 6.0
    if peg <= PEG_POOR:
        return 4.0
    return 2.0


def _pe_score(pe: float) -> float:
    """Score PE ratio (lower is better)."""
    if pe <= PE_EXCELLENT:
        return 9.0
    if pe <= PE_GOOD:
        return 7.0
    if pe <= PE_FAIR:
        return 5.0
    if pe <= PE_MODERATE:
        return 3.0
    return 2.0


def _growth_score(growth: float) -> float:
    """Score earnings growth rate (higher is better)."""
    if growth >= GROWTH_EXCELLENT:
        return 9.0
    if growth >= GROWTH_GOOD:
        return 8.0
    if growth >= GROWTH_FAIR:
        return 6.0
    if growth >= GROWTH_MODERATE:
        return 4.0
    if growth >= 0:
        return 3.0
    return 2.0


def _rating_score(ratings: list[dict] | None) -> float | None:
    """Convert analyst ratings to average score."""
    if not ratings:
        return None

    scores: list[float] = []
    for rating in ratings:
        grade = rating.get("toGrade") or rating.get("rating") or rating.get("grade")
        if not isinstance(grade, str):
            continue

        score = _parse_rating_grade(grade.lower())
        if score is not None:
            scores.append(score)

    if not scores:
        return None
    return round(sum(scores) / len(scores), 2)


def _parse_rating_grade(text: str) -> float | None:
    """Parse rating grade text to numeric score."""
    text = text.lower()

    # Mapping of keywords to scores
    ratings_map = {
        "strong buy": 9.5,
        "buy": 8.5,
        "overweight": 7.5,
        "outperform": 7.5,
        "hold": 5.0,
        "neutral": 5.0,
        "underperform": 3.0,
        "underweight": 3.0,
        "sell": 1.0,
    }

    # Check for exact matches or keywords
    if "strong" in text and "buy" in text:
        return ratings_map["strong buy"]

    for keyword, score in ratings_map.items():
        if keyword in text:
            return score

    return None


def _normalize_yahoo_ticker(ticker: str) -> str:
    return ticker.replace(" ", "-").replace(".", "-")
