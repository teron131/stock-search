from typing import Final

B: Final[float] = 1e9
T: Final[float] = 1e12


class MarketCapConfig:
    """Configuration for mapping market capitalization values (Log-S-curve)."""

    MIN: Final[float] = 10 * B
    MEDIAN: Final[float] = 800 * B
    MAX: Final[float] = 4.5 * T


class CalibrationConfig:
    """Calibration ranges for mapping various financial metrics to 0-10 scores."""

    PEG_RANGE: Final[tuple[float, float, float]] = (0.5, 1.5, 3.0)
    PE_RANGE: Final[tuple[float, float, float]] = (10.0, 28.0, 50.0)
    GROWTH_RANGE: Final[tuple[float, float, float]] = (0.1, 0.3, 0.5)
    UPSIDE_RANGE: Final[tuple[float, float, float]] = (0.0, 15.0, 50.0)
    PROBABILITY_RANGE: Final[tuple[float, float, float]] = (0.5, 0.55, 0.6)
    RATING_RANGE: Final[tuple[float, float, float]] = (1.0, 3.5, 5.0)


class ValuationWeights:
    """Weights used for blending PEG, P/E, and Growth into a valuation score."""

    PEG: Final[float] = 0.55
    PE: Final[float] = 0.2
    PE_FORWARD: Final[float] = 0.15
    GROWTH: Final[float] = 0.1


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
    WEB_SEARCH_MAX_RESULTS: Final[int] = 15
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
