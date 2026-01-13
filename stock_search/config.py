B = 1e9
T = 1e12


class MarketCapConfig:
    """Configuration for mapping market capitalization values (Log-S-curve)."""

    MIN = 10 * B
    MEDIAN = 800 * B
    MAX = 4.5 * T


class CalibrationConfig:
    """Calibration ranges for mapping various financial metrics to 0-10 scores."""

    PEG_RANGE = (0.5, 1.5, 3.0)
    PE_RANGE = (10.0, 28.0, 50.0)
    GROWTH_RANGE = (0.1, 0.3, 0.5)
    UPSIDE_RANGE = (0.0, 15.0, 50.0)
    PROBABILITY_RANGE = (0.5, 0.55, 0.6)
    RATING_RANGE = (1.0, 3.5, 5.0)


class ValuationWeights:
    """Weights used for blending PEG, P/E, and Growth into a valuation score."""

    PEG = 0.55
    PE = 0.2
    PE_FORWARD = 0.15
    GROWTH = 0.1


class CoreEngineWeights:
    """Strategy weights for 'Core' portfolio bucket (Quality & Moat focused)."""

    MOAT = 0.35
    QUALITY = 0.35
    VALUATION = 0.15
    SIZE = 0.10
    EDGE = 0.05


class SatelliteWeights:
    """Strategy weights for 'Satellite' portfolio bucket (Growth & Upside focused)."""

    MOAT = 0.30
    QUALITY = 0.25
    UPSIDE = 0.25
    VALUATION = 0.10
    EDGE = 0.10


class SpeculativeWeights:
    """Strategy weights for 'Speculative' portfolio bucket (High upside, lower core)."""

    UPSIDE = 0.45
    QUALITY = 0.20
    MOAT = 0.20
    VALUATION = 0.15


class DiversifierWeights:
    """Strategy weights for 'Diversifier' portfolio bucket (Balanced defensive)."""

    QUALITY = 0.45
    VALUATION = 0.25
    SIZE = 0.20
    UPSIDE = 0.10


class ThresholdConfig:
    """Various thresholds and parameters for signal detection and LLM behavior."""

    UPSIDE_MAX_PCT = 50
    FOMO_VALUATION = 3.0
    FOMO_UPSIDE = 8.0
    FOMO_BULL = 5.8
    WEB_SEARCH_MAX_RESULTS = 15
    DIRECTION_CHANGE_DIVISOR = 10
    DIRECTION_BASE_SCORE = 5.0


class GameTierThresholds:
    """Thresholds for categorizing the 'Edge' level (conviction) of a setup."""

    RARE_DISLOCATION = 6.8
    SMURFING_MIN = 6.3
    SMURFING_MAX = 6.7
    VERY_HIGH_MIN = 5.9
    VERY_HIGH_MAX = 6.2
    HIGH_EDGE_MIN = 5.5
    HIGH_EDGE_MAX = 5.8
