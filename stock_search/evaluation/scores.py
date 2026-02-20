import math

from ..indicators import StockIndicator
from ..schemas import FutureOutlook
from .constants import (
    EDGE_BASE,
    EDGE_MULTIPLIER,
    SCORE_SCALE,
    CalibrationConfig,
    CoreEngineWeights,
    DiversifierWeights,
    GameTierThresholds,
    MarketCapConfig,
    QualitySignalWeights,
    SatelliteWeights,
    SpeculativeWeights,
    StrategyBucket,
    ThresholdConfig,
    ValuationWeights,
)
from .math_utils import clamp_score, z_score_map

WeightedFactorConfig = tuple[float | None, tuple[float, float, float], float, bool]

_MOMENTUM_INPUTS = (
    "change_percent",
    "one_month_change_percent",
    "three_month_change_percent",
    "six_month_change_percent",
    "one_year_change_percent",
)

_STRATEGY_BUCKETS: dict[str, StrategyBucket] = {
    "core": StrategyBucket(
        score_keys=("moat_score", "quality_score", "valuation_score", "size_score"),
        weights=(CoreEngineWeights.MOAT, CoreEngineWeights.QUALITY, CoreEngineWeights.VALUATION, CoreEngineWeights.SIZE),
        edge_weight=CoreEngineWeights.EDGE,
    ),
    "satellite": StrategyBucket(
        score_keys=("moat_score", "quality_score", "valuation_score", "upside_score"),
        weights=(SatelliteWeights.MOAT, SatelliteWeights.QUALITY, SatelliteWeights.VALUATION, SatelliteWeights.UPSIDE),
        edge_weight=SatelliteWeights.EDGE,
    ),
    "speculative": StrategyBucket(
        score_keys=("moat_score", "quality_score", "valuation_score", "upside_score"),
        weights=(SpeculativeWeights.MOAT, SpeculativeWeights.QUALITY, SpeculativeWeights.VALUATION, SpeculativeWeights.UPSIDE),
        edge_weight=0.0,
    ),
    "diversifier": StrategyBucket(
        score_keys=("quality_score", "valuation_score", "size_score", "upside_score"),
        weights=(DiversifierWeights.QUALITY, DiversifierWeights.VALUATION, DiversifierWeights.SIZE, DiversifierWeights.UPSIDE),
        edge_weight=0.0,
    ),
}


def _weighted_zscore_average(factors: list[WeightedFactorConfig]) -> float | None:
    """Average weighted z-score mapped factors, skipping missing values."""
    weighted_scores: list[float] = []
    total_weight = 0.0

    for value, input_range, weight, inverse in factors:
        if value is None:
            continue
        range_min, range_median, range_max = input_range
        score = z_score_map(
            value,
            in_min=range_min,
            in_max=range_max,
            in_median=range_median,
            out_min=10.0 if inverse else 0.0,
            out_max=0.0 if inverse else 10.0,
        )
        weighted_scores.append(score * weight)
        total_weight += weight

    if total_weight == 0:
        return None
    return clamp_score(sum(weighted_scores) / total_weight)


def _fcf_yield_percent(indicator: StockIndicator) -> float | None:
    market_cap = indicator.market_cap
    free_cash_flow = indicator.free_cash_flow
    if free_cash_flow is None or market_cap is None or market_cap <= 0:
        return None
    return (free_cash_flow / market_cap) * 100


def market_cap_score(
    info: dict | None = None,
) -> float | None:
    """Map market cap to 1-10 using a Log-S-curve.

    Requires `info` dict to be provided.
    """
    if info is None:
        return None
    mcap = info.get("marketCap")
    if info.get("quoteType") == "ETF" or not mcap:
        return None

    return z_score_map(
        math.log10(mcap),
        in_min=math.log10(MarketCapConfig.MIN),
        in_median=math.log10(MarketCapConfig.MEDIAN),
        in_max=math.log10(MarketCapConfig.MAX),
    )


def calculate_valuation_score(indicator: StockIndicator) -> float | None:
    """Compute weighted valuation score from valuation and balance-sheet metrics."""
    valuation_factors: list[WeightedFactorConfig] = [
        (
            indicator.peg,
            CalibrationConfig.PEG_RANGE,
            ValuationWeights.PEG,
            True,
        ),
        (
            indicator.pe,
            CalibrationConfig.TRAILING_PE_RANGE,
            ValuationWeights.PE,
            True,
        ),
        (
            indicator.pe_forward,
            CalibrationConfig.FORWARD_PE_RANGE,
            ValuationWeights.PE_FORWARD,
            True,
        ),
        (
            indicator.debt_to_equity,
            CalibrationConfig.DEBT_TO_EQUITY_PCT_RANGE,
            ValuationWeights.DEBT_TO_EQUITY,
            True,
        ),
        (
            _fcf_yield_percent(indicator),
            CalibrationConfig.FCF_YIELD_PCT_RANGE,
            ValuationWeights.FCF_YIELD,
            False,
        ),
    ]
    return _weighted_zscore_average(valuation_factors)


def calculate_quality_signal_score(indicator: StockIndicator) -> float | None:
    """Compute market-derived quality score from growth and margin."""
    quality_factors: list[WeightedFactorConfig] = [
        (
            indicator.revenue_growth,
            CalibrationConfig.REVENUE_GROWTH_PCT_RANGE,
            QualitySignalWeights.REVENUE_GROWTH,
            False,
        ),
        (
            indicator.gross_margin,
            CalibrationConfig.GROSS_MARGIN_PCT_RANGE,
            QualitySignalWeights.GROSS_MARGIN,
            False,
        ),
    ]
    return _weighted_zscore_average(quality_factors)


def calculate_combined_upside_score(
    median_upside: float | None,
    ratings: list[dict] | None,
    outlook_score: float | None,
) -> float | None:
    """Blend analyst upside, current ratings, and LLM outlook into a single score."""
    range_min, range_median, range_max = CalibrationConfig.UPSIDE_RANGE
    analyst_upside_score = None
    if median_upside is not None:
        analyst_upside_score = z_score_map(
            median_upside,
            in_min=range_min,
            in_max=range_max,
            in_median=range_median,
        )

    rating_score = calculate_rating_score(ratings)

    available_scores = [value for value in (analyst_upside_score, rating_score, outlook_score) if value is not None]
    return clamp_score(sum(available_scores) / len(available_scores)) if available_scores else None


def calculate_rating_score(ratings: list[dict] | None) -> float | None:
    """Map list of analyst ratings to 0-10 engine score."""
    if not ratings:
        return None

    rating_values = []
    for rating_row in ratings:
        grade = rating_row.get("toGrade") or rating_row.get("rating") or rating_row.get("grade")
        if isinstance(grade, str):
            parsed_score = _parse_rating_grade(grade)
            if parsed_score is not None:
                rating_values.append(parsed_score)

    if not rating_values:
        return None

    range_min, range_median, range_max = CalibrationConfig.RATING_RANGE
    return z_score_map(
        sum(rating_values) / len(rating_values),
        in_min=range_min,
        in_max=range_max,
        in_median=range_median,
    )


def _parse_rating_grade(text: str) -> float | None:
    """Parse common rating strings to 1-5 scale."""
    normalized_text = text.lower()
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
    if "strong" in normalized_text and "buy" in normalized_text:
        return 5.0
    for keyword, value in mapping.items():
        if keyword in normalized_text:
            return value
    return None


def _probability_to_score(value: float | None) -> float | None:
    """Map probability to 0-10 using a Normal CDF (S-curve)."""
    if value is None:
        return None
    range_min, range_median, range_max = CalibrationConfig.PROBABILITY_RANGE
    return z_score_map(value, range_min, range_max, range_median)


def model_probabilities(
    indicator: StockIndicator,
    outlook: FutureOutlook | None,
) -> tuple[float | None, float | None]:
    """Derive calibrated bull/bear scores from LLM and/or Historical momentum."""
    # momentum: Historical momentum scores (0-10) derived from average of moving averages
    bull_momentum_score, bear_momentum_score = calculate_historical_momentum_scores(indicator)
    bull_momentum_probability = _probability_to_score(
        bull_momentum_score / SCORE_SCALE if bull_momentum_score is not None else None,
    )
    bear_momentum_probability = _probability_to_score(
        bear_momentum_score / SCORE_SCALE if bear_momentum_score is not None else None,
    )

    # LLM: LLM results (0-10)
    bull_llm_probability, bear_llm_probability = None, None
    if outlook and outlook.bull_probability is not None and outlook.bear_probability is not None:
        bull_llm_probability = _probability_to_score(outlook.bull_probability)
        bear_llm_probability = _probability_to_score(outlook.bear_probability)

    # Blending logic: If LLM exists, return mean(LLM, momentum), else return momentum
    if bull_llm_probability is None or bear_llm_probability is None:
        return bull_momentum_probability, bear_momentum_probability
    if bull_momentum_probability is None or bear_momentum_probability is None:
        return bull_llm_probability, bear_llm_probability
    return (
        (bull_llm_probability + bull_momentum_probability) / 2,
        (bear_llm_probability + bear_momentum_probability) / 2,
    )


def calculate_historical_momentum_scores(indicator: StockIndicator) -> tuple[float | None, float | None]:
    """Average recent price changes into a 0-10 momentum score."""
    changes = [getattr(indicator, metric_name) for metric_name in _MOMENTUM_INPUTS]
    valid_changes = [change for change in changes if isinstance(change, (int, float))]
    if not valid_changes:
        return None, None

    average_change = sum(valid_changes) / len(valid_changes)
    return (
        clamp_score(ThresholdConfig.DIRECTION_BASE_SCORE + average_change / ThresholdConfig.DIRECTION_CHANGE_DIVISOR),
        clamp_score(ThresholdConfig.DIRECTION_BASE_SCORE - average_change / ThresholdConfig.DIRECTION_CHANGE_DIVISOR),
    )


def calculate_strategy_indices(
    scores: dict[str, float | None],
    edge: float | None,
) -> dict[str, float | None]:
    """Apply strategy weights to core scores to find suitable portfolio buckets."""
    edge_component = (EDGE_BASE + (EDGE_MULTIPLIER * edge)) if edge is not None else None

    indices: dict[str, float | None] = {}
    for name, bucket in _STRATEGY_BUCKETS.items():
        bucket_scores = [scores[key] for key in bucket.score_keys]
        if all(score is not None for score in bucket_scores) and (bucket.edge_weight == 0 or edge_component is not None):
            weighted_score = sum(score * weight for score, weight in zip(bucket_scores, bucket.weights, strict=False))
            indices[name] = weighted_score + (bucket.edge_weight * (edge_component or 0))
        else:
            indices[name] = None
    return indices


def check_fomo_conditions(
    scores: dict[str, float | None],
    bull_score: float | None,
) -> bool:
    """Return True if an asset looks like a 'chase' opportunity."""
    valuation_score = scores.get("valuation_score")
    upside_score = scores.get("upside_score")
    if valuation_score is None or upside_score is None or bull_score is None:
        return False
    return valuation_score <= ThresholdConfig.FOMO_VALUATION and upside_score >= ThresholdConfig.FOMO_UPSIDE and bull_score <= ThresholdConfig.FOMO_BULL


def calculate_elo_delta(probability: float | None) -> float | None:
    """Calculate Elo delta based on success probability."""
    if probability is None or not (0 < probability < 1):
        return None
    return 400 * math.log10(probability / (1 - probability))


def get_game_tier(bull_score: float | None) -> str:
    """Categorize the 'edge' level of the setup."""
    if bull_score is None:
        return "normal"
    if bull_score >= GameTierThresholds.RARE_DISLOCATION:
        return "rare dislocation-level"
    if GameTierThresholds.SMURFING_MIN <= bull_score <= GameTierThresholds.SMURFING_MAX:
        return "smurfing"
    if GameTierThresholds.VERY_HIGH_MIN <= bull_score <= GameTierThresholds.VERY_HIGH_MAX:
        return "very high"
    if GameTierThresholds.HIGH_EDGE_MIN <= bull_score <= GameTierThresholds.HIGH_EDGE_MAX:
        return "already high edge"
    return "normal"
