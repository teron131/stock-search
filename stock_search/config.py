class MarketCapConfig:
    B = 1e9
    T = 1e12
    MIN = 10 * B
    MEDIAN = 800 * B
    MAX = 4.5 * T


class CalibrationConfig:
    PEG_RANGE = (0.5, 1.5, 3.0)
    PE_RANGE = (10.0, 28.0, 50.0)
    GROWTH_RANGE = (0.1, 0.3, 0.5)
    UPSIDE_RANGE = (0.0, 15.0, 50.0)
    PROBABILITY_RANGE = (0.5, 0.55, 0.6)
    RATING_RANGE = (1.0, 3.5, 5.0)


class ValuationWeights:
    PEG = 0.55
    PE = 0.2
    PE_FORWARD = 0.15
    GROWTH = 0.1


class CoreEngineWeights:
    MOAT = 0.35
    QUALITY = 0.35
    VALUATION = 0.15
    SIZE = 0.10
    EDGE = 0.05


class SatelliteWeights:
    MOAT = 0.30
    QUALITY = 0.25
    UPSIDE = 0.25
    VALUATION = 0.10
    EDGE = 0.10


class SpeculativeWeights:
    UPSIDE = 0.45
    QUALITY_INVERSE = 0.20
    MOAT_INVERSE = 0.20
    VALUATION_INVERSE = 0.15


class DiversifierWeights:
    QUALITY = 0.45
    VALUATION = 0.25
    SIZE = 0.20
    UPSIDE_INVERSE = 0.10


class ThresholdConfig:
    UPSIDE_MAX_PCT = 50
    FOMO_VALUATION = 3.0
    FOMO_UPSIDE = 8.0
    FOMO_BULL = 5.8
    WEB_SEARCH_MAX_RESULTS = 15
    DIRECTION_CHANGE_DIVISOR = 10
    DIRECTION_BASE_SCORE = 5.0


class GameTierThresholds:
    RARE_DISLOCATION = 6.8
    SMURFING_MIN = 6.3
    SMURFING_MAX = 6.7
    VERY_HIGH_MIN = 5.9
    VERY_HIGH_MAX = 6.2
    HIGH_EDGE_MIN = 5.5
    HIGH_EDGE_MAX = 5.8
