/** Define evaluation scoring defaults and calibration settings. */

export const BILLION = 1e9;
export const TRILLION = 1e12;

export type MinMedMax = [number, number, number];

export const DEFAULT_SCORE = 5;
export const DEFAULT_BULL_PROBABILITY = 0.5;
export const DEFAULT_BEAR_PROBABILITY = 0.2;

export const SCORE_SCALE = 10;
export const ROUND_PROBABILITY_DIGITS = 4;
export const QUALITY_RESEARCH_WEIGHT = 0.7;
export const QUALITY_SIGNAL_WEIGHT = 0.3;
export const ELO_K_FACTOR = 400;
export const EXPECTED_DRAW_WEIGHT = 0.5;
export const EDGE_BASE = 5;
export const EDGE_MULTIPLIER = 0.5;

export type StrategyBucket = {
	scoreKeys: [string, string, string, string];
	weights: [number, number, number, number];
	invertFlags: [boolean, boolean, boolean, boolean];
	edgeWeight: number;
};

export class MarketCapConfig {
	/** Configuration for mapping market capitalization values (Log-S-curve). */
	static readonly MIN = 10 * BILLION;
	static readonly MEDIAN = 800 * BILLION;
	static readonly MAX = 4 * TRILLION;
}

export class CalibrationConfig {
	/** Calibration ranges for mapping various financial metrics to 0-10 scores. */
	static readonly PEG_RANGE: MinMedMax = [0.5, 1.5, 3.0];
	static readonly TRAILING_PE_RANGE: MinMedMax = [12.0, 40.0, 75.0];
	static readonly FORWARD_PE_RANGE: MinMedMax = [12.0, 30.0, 60.0];
	static readonly GROWTH_RANGE: MinMedMax = [0.1, 0.3, 0.5];
	static readonly REVENUE_GROWTH_PCT_RANGE: MinMedMax = [0.0, 15.0, 30.0];
	static readonly GROSS_MARGIN_PCT_RANGE: MinMedMax = [10.0, 45.0, 70.0];
	static readonly OPERATING_MARGIN_PCT_RANGE: MinMedMax = [0.0, 20.0, 40.0];
	static readonly DEBT_TO_EQUITY_PCT_RANGE: MinMedMax = [0.0, 60.0, 200.0];
	static readonly FCF_YIELD_PCT_RANGE: MinMedMax = [-2.0, 3.0, 8.0];
	static readonly UPSIDE_RANGE: MinMedMax = [0.0, 15.0, 50.0];
	static readonly PROBABILITY_RANGE: MinMedMax = [0.5, 0.55, 0.6];
	static readonly RATING_RANGE: MinMedMax = [1.0, 3.5, 5.0];
}

export class ValuationWeights {
	/** Weights used for blending PEG, P/E, and Growth into a valuation score. */
	static readonly PEG = 0.45;
	static readonly PE = 0.2;
	static readonly PE_FORWARD = 0.15;
	static readonly DEBT_TO_EQUITY = 0.1;
	static readonly FCF_YIELD = 0.1;
}

export class QualitySignalWeights {
	/** Weights for market-derived quality overlays. */
	static readonly REVENUE_GROWTH = 0.4;
	static readonly GROSS_MARGIN = 0.3;
	static readonly OPERATING_MARGIN = 0.3;
}

export class CoreEngineWeights {
	/** Strategy weights for 'Core' portfolio bucket (Quality & Moat focused). */
	static readonly MOAT = 0.35;
	static readonly QUALITY = 0.35;
	static readonly VALUATION = 0.15;
	static readonly SIZE = 0.1;
	static readonly EDGE = 0.05;
}

export class SatelliteWeights {
	/** Strategy weights for 'Satellite' portfolio bucket (Growth & Upside focused). */
	static readonly MOAT = 0.3;
	static readonly QUALITY = 0.25;
	static readonly UPSIDE = 0.25;
	static readonly VALUATION = 0.1;
	static readonly EDGE = 0.1;
}

export class SpeculativeWeights {
	/** Strategy weights for 'Speculative' portfolio bucket (High upside, lower core). */
	static readonly UPSIDE = 0.45;
	static readonly QUALITY = 0.2;
	static readonly MOAT = 0.2;
	static readonly VALUATION = 0.15;
}

export class DiversifierWeights {
	/** Strategy weights for 'Diversifier' portfolio bucket (Balanced defensive). */
	static readonly QUALITY = 0.45;
	static readonly VALUATION = 0.25;
	static readonly SIZE = 0.2;
	static readonly UPSIDE = 0.1;
}

export class ThresholdConfig {
	/** Various thresholds and parameters for signal detection and LLM behavior. */
	static readonly UPSIDE_MAX_PCT = 50;
	static readonly FOMO_VALUATION = 3;
	static readonly FOMO_UPSIDE = 8;
	static readonly FOMO_BULL = 5.8;
	static readonly WEB_SEARCH_MAX_RESULTS = 5;
	static readonly DIRECTION_CHANGE_DIVISOR = 10;
	static readonly DIRECTION_BASE_SCORE = 5;
}

export class GameTierThresholds {
	/** Thresholds for categorizing the 'Edge' level (conviction) of a setup. */
	static readonly RARE_DISLOCATION = 6.8;
	static readonly SMURFING_MIN = 6.3;
	static readonly SMURFING_MAX = 6.7;
	static readonly VERY_HIGH_MIN = 5.9;
	static readonly VERY_HIGH_MAX = 6.2;
	static readonly HIGH_EDGE_MIN = 5.5;
	static readonly HIGH_EDGE_MAX = 5.8;
}
