"""Define evaluation scoring defaults and calibration settings."""

from typing import Final, NamedTuple

B: Final[float] = 1e9
T: Final[float] = 1e12
MinMedMax = tuple[float, float, float]

DEFAULT_SCORE: Final[float] = 5.0
DEFAULT_BULL_PROBABILITY: Final[float] = 0.5
DEFAULT_BEAR_PROBABILITY: Final[float] = 0.2

# --- Scoring Constants ---
SCORE_SCALE: Final[float] = 10.0
ROUND_PROBABILITY_DIGITS: Final[int] = 4
QUALITY_RESEARCH_WEIGHT: Final[float] = 0.7
QUALITY_SIGNAL_WEIGHT: Final[float] = 0.3
ELO_K_FACTOR: Final[float] = 400.0
EXPECTED_DRAW_WEIGHT: Final[float] = 0.5
EDGE_BASE: Final[float] = 5.0
EDGE_MULTIPLIER: Final[float] = 0.5


class StrategyBucket(NamedTuple):
    """Configuration for a portfolio strategy bucket."""

    score_keys: tuple[str, ...]
    weights: tuple[float, ...]
    invert_flags: tuple[bool, ...]
    edge_weight: float


class MarketCapConfig:
    """Configuration for mapping market capitalization values (Log-S-curve)."""

    MIN: Final[float] = 10 * B
    MEDIAN: Final[float] = 800 * B
    MAX: Final[float] = 4.0 * T


class CalibrationConfig:
    """Calibration ranges for mapping various financial metrics to 0-10 scores."""

    PEG_RANGE: Final[MinMedMax] = (0.5, 1.5, 3.0)
    TRAILING_PE_RANGE: Final[MinMedMax] = (12.0, 40.0, 75.0)
    FORWARD_PE_RANGE: Final[MinMedMax] = (12.0, 30.0, 60.0)
    GROWTH_RANGE: Final[MinMedMax] = (0.1, 0.3, 0.5)
    REVENUE_GROWTH_PCT_RANGE: Final[MinMedMax] = (0.0, 15.0, 30.0)
    GROSS_MARGIN_PCT_RANGE: Final[MinMedMax] = (10.0, 45.0, 70.0)
    DEBT_TO_EQUITY_PCT_RANGE: Final[MinMedMax] = (0.0, 60.0, 200.0)
    FCF_YIELD_PCT_RANGE: Final[MinMedMax] = (-2.0, 3.0, 8.0)
    UPSIDE_RANGE: Final[MinMedMax] = (0.0, 15.0, 50.0)
    PROBABILITY_RANGE: Final[MinMedMax] = (0.5, 0.55, 0.6)
    RATING_RANGE: Final[MinMedMax] = (1.0, 3.5, 5.0)


class ValuationWeights:
    """Weights used for blending PEG, P/E, and Growth into a valuation score."""

    PEG: Final[float] = 0.45
    PE: Final[float] = 0.2
    PE_FORWARD: Final[float] = 0.15
    DEBT_TO_EQUITY: Final[float] = 0.1
    FCF_YIELD: Final[float] = 0.1


class QualitySignalWeights:
    """Weights for market-derived quality overlays."""

    REVENUE_GROWTH: Final[float] = 0.60
    GROSS_MARGIN: Final[float] = 0.40


class CoreEngineWeights:
    """Strategy weights for 'Core' portfolio bucket (Quality & Moat focused)."""

    MOAT: Final[float] = 0.35
    QUALITY: Final[float] = 0.35
    VALUATION: Final[float] = 0.15
    SIZE: Final[float] = 0.10
    EDGE: Final[float] = 0.05


class SatelliteWeights:
    """Strategy weights for 'Satellite' portfolio bucket (Growth & Upside focused)."""

    MOAT: Final[float] = 0.30
    QUALITY: Final[float] = 0.25
    UPSIDE: Final[float] = 0.25
    VALUATION: Final[float] = 0.10
    EDGE: Final[float] = 0.10


class SpeculativeWeights:
    """Strategy weights for 'Speculative' portfolio bucket (High upside, lower core)."""

    UPSIDE: Final[float] = 0.45
    QUALITY: Final[float] = 0.20
    MOAT: Final[float] = 0.20
    VALUATION: Final[float] = 0.15


class DiversifierWeights:
    """Strategy weights for 'Diversifier' portfolio bucket (Balanced defensive)."""

    QUALITY: Final[float] = 0.45
    VALUATION: Final[float] = 0.25
    SIZE: Final[float] = 0.20
    UPSIDE: Final[float] = 0.10


class ThresholdConfig:
    """Various thresholds and parameters for signal detection and LLM behavior."""

    UPSIDE_MAX_PCT: Final[float] = 50
    FOMO_VALUATION: Final[float] = 3.0
    FOMO_UPSIDE: Final[float] = 8.0
    FOMO_BULL: Final[float] = 5.8
    WEB_SEARCH_MAX_RESULTS: Final[int] = 5
    DIRECTION_CHANGE_DIVISOR: Final[float] = 10.0
    DIRECTION_BASE_SCORE: Final[float] = 5.0


class GameTierThresholds:
    """Thresholds for categorizing the 'Edge' level (conviction) of a setup."""

    RARE_DISLOCATION: Final[float] = 6.8
    SMURFING_MIN: Final[float] = 6.3
    SMURFING_MAX: Final[float] = 6.7
    VERY_HIGH_MIN: Final[float] = 5.9
    VERY_HIGH_MAX: Final[float] = 6.2
    HIGH_EDGE_MIN: Final[float] = 5.5
    HIGH_EDGE_MAX: Final[float] = 5.8
