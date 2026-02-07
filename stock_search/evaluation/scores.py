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

WeightedConfig = tuple[float | None, tuple[float, float, float], float, bool]

_MOMENTUM_INPUTS = (
    "change_percent",
    "one_month_change_percent",
    "three_month_change_percent",
    "six_month_change_percent",
    "one_year_change_percent",
)

_STRATEGY_BUCKETS: dict[str, StrategyBucket] = {
    "core": StrategyBucket(
        score_keys=("moat", "quality", "valuation", "size"),
        weights=(CoreEngineWeights.MOAT, CoreEngineWeights.QUALITY, CoreEngineWeights.VALUATION, CoreEngineWeights.SIZE),
        edge_weight=CoreEngineWeights.EDGE,
    ),
    "satellite": StrategyBucket(
        score_keys=("moat", "quality", "valuation", "upside"),
        weights=(SatelliteWeights.MOAT, SatelliteWeights.QUALITY, SatelliteWeights.VALUATION, SatelliteWeights.UPSIDE),
        edge_weight=SatelliteWeights.EDGE,
    ),
    "speculative": StrategyBucket(
        score_keys=("moat", "quality", "valuation", "upside"),
        weights=(SpeculativeWeights.MOAT, SpeculativeWeights.QUALITY, SpeculativeWeights.VALUATION, SpeculativeWeights.UPSIDE),
        edge_weight=0.0,
    ),
    "diversifier": StrategyBucket(
        score_keys=("quality", "valuation", "size", "upside"),
        weights=(DiversifierWeights.QUALITY, DiversifierWeights.VALUATION, DiversifierWeights.SIZE, DiversifierWeights.UPSIDE),
        edge_weight=0.0,
    ),
}


def _weighted_zscore_average(configs: list[WeightedConfig]) -> float | None:
    """Average weighted z-score mapped factors, skipping missing values."""
    weighted_scores: list[float] = []
    total_weight = 0.0

    for value, range_values, weight, inverse in configs:
        if value is None:
            continue
        range_min, range_median, range_max = range_values
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
    info = indicator.info
    valuation_factors: list[WeightedConfig] = [
        (
            info.get("trailingPegRatio"),
            CalibrationConfig.PEG_RANGE,
            ValuationWeights.PEG,
            True,
        ),
        (
            info.get("trailingPE"),
            CalibrationConfig.TRAILING_PE_RANGE,
            ValuationWeights.PE,
            True,
        ),
        (
            info.get("forwardPE"),
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
    quality_factors: list[WeightedConfig] = [
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
    i_min, i_med, i_max = CalibrationConfig.UPSIDE_RANGE
    u_score = None
    if median_upside is not None:
        u_score = z_score_map(
            median_upside,
            in_min=i_min,
            in_max=i_max,
            in_median=i_med,
        )

    r_score = calculate_rating_score(ratings)

    values = [v for v in (u_score, r_score, outlook_score) if v is not None]
    return clamp_score(sum(values) / len(values)) if values else None


def calculate_rating_score(ratings: list[dict] | None) -> float | None:
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

    i_min, i_med, i_max = CalibrationConfig.RATING_RANGE
    return z_score_map(sum(scores) / len(scores), in_min=i_min, in_max=i_max, in_median=i_med)


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


def _probability_to_score(value: float | None) -> float | None:
    if value is None:
        return None
    p_min, p_med, p_max = CalibrationConfig.PROBABILITY_RANGE
    return z_score_map(value, p_min, p_max, p_med)


def model_probabilities(
    indicator: StockIndicator,
    outlook: FutureOutlook | None,
) -> tuple[float | None, float | None]:
    """Derive calibrated bull/bear scores from LLM and/or Historical momentum."""
    # momentum: Historical momentum scores (0-10) derived from average of moving averages
    bull_momentum_raw, bear_momentum_raw = calculate_historical_momentum_scores(indicator)
    bull_momentum = _probability_to_score(
        bull_momentum_raw / SCORE_SCALE if bull_momentum_raw is not None else None,
    )
    bear_momentum = _probability_to_score(
        bear_momentum_raw / SCORE_SCALE if bear_momentum_raw is not None else None,
    )

    # LLM: LLM results (0-10)
    bull_llm, bear_llm = None, None
    if outlook and outlook.bull_probability is not None and outlook.bear_probability is not None:
        bull_llm = _probability_to_score(outlook.bull_probability)
        bear_llm = _probability_to_score(outlook.bear_probability)

    # Blending logic: If LLM exists, return mean(LLM, momentum), else return momentum
    if bull_llm is not None and bear_llm is not None:
        if bull_momentum is not None and bear_momentum is not None:
            return (bull_llm + bull_momentum) / 2, (bear_llm + bear_momentum) / 2
        return bull_llm, bear_llm

    return bull_momentum, bear_momentum


def calculate_historical_momentum_scores(indicator: StockIndicator) -> tuple[float | None, float | None]:
    """Average recent price changes into a 0-10 momentum score."""
    changes = [getattr(indicator, metric_name) for metric_name in _MOMENTUM_INPUTS]
    valid = [v for v in changes if isinstance(v, (int, float))]
    if not valid:
        return None, None

    avg = sum(valid) / len(valid)
    return (
        clamp_score(ThresholdConfig.DIRECTION_BASE_SCORE + avg / ThresholdConfig.DIRECTION_CHANGE_DIVISOR),
        clamp_score(ThresholdConfig.DIRECTION_BASE_SCORE - avg / ThresholdConfig.DIRECTION_CHANGE_DIVISOR),
    )


def calculate_strategy_indices(
    scores: dict[str, float | None],
    edge: float | None,
) -> dict[str, float | None]:
    """Apply strategy weights to core scores to find suitable portfolio buckets."""
    edge_component = (EDGE_BASE + (EDGE_MULTIPLIER * edge)) if edge is not None else None

    indices: dict[str, float | None] = {}
    for name, bucket in _STRATEGY_BUCKETS.items():
        vals = [scores[key] for key in bucket.score_keys]
        if all(v is not None for v in vals) and (bucket.edge_weight == 0 or edge_component is not None):
            weighted = sum(v * w for v, w in zip(vals, bucket.weights, strict=False))
            indices[name] = weighted + (bucket.edge_weight * (edge_component or 0))
        else:
            indices[name] = None
    return indices


def check_fomo_conditions(
    scores: dict,
    bull_score: float | None,
) -> bool:
    """Return True if an asset looks like a 'chase' opportunity."""
    v, u = scores.get("valuation"), scores.get("upside")
    if v is None or u is None or bull_score is None:
        return False
    return v <= ThresholdConfig.FOMO_VALUATION and u >= ThresholdConfig.FOMO_UPSIDE and bull_score <= ThresholdConfig.FOMO_BULL


def calculate_elo_delta(p: float | None) -> float | None:
    """Calculate Elo delta based on success probability."""
    if p is None or not (0 < p < 1):
        return None
    return 400 * math.log10(p / (1 - p))


def get_game_tier(bull: float | None) -> str:
    """Categorize the 'edge' level of the setup."""
    if bull is None:
        return "normal"
    if bull >= GameTierThresholds.RARE_DISLOCATION:
        return "rare dislocation-level"
    if GameTierThresholds.SMURFING_MIN <= bull <= GameTierThresholds.SMURFING_MAX:
        return "smurfing"
    if GameTierThresholds.VERY_HIGH_MIN <= bull <= GameTierThresholds.VERY_HIGH_MAX:
        return "very high"
    if GameTierThresholds.HIGH_EDGE_MIN <= bull <= GameTierThresholds.HIGH_EDGE_MAX:
        return "already high edge"
    return "normal"
