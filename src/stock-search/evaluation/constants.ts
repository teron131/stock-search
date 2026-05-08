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

/** Configuration for mapping market capitalization values (Log-S-curve). */
export const MarketCapConfig = {
	MIN: 10 * BILLION,
	MEDIAN: 800 * BILLION,
	MAX: 4.5 * TRILLION,
} as const;

/** Calibration ranges for mapping various financial metrics to 0-10 scores. */
export const CalibrationConfig = {
	PEG_RANGE: [0.7, 2.0, 4.0],
	TRAILING_PE_RANGE: [12.0, 30.0, 80.0],
	FORWARD_PE_RANGE: [10.0, 28.0, 65.0],
	GROWTH_RANGE: [0.1, 0.3, 0.5],
	REVENUE_GROWTH_PCT_RANGE: [-10.0, 12.0, 35.0],
	GROSS_MARGIN_PCT_RANGE: [20.0, 50.0, 75.0],
	OPERATING_MARGIN_PCT_RANGE: [-15.0, 15.0, 35.0],
	ROIC_PCT_RANGE: [0.0, 12.0, 30.0],
	DEBT_TO_EQUITY_PCT_RANGE: [0.0, 100.0, 300.0],
	FCF_YIELD_PCT_RANGE: [-5.0, 2.0, 8.0],
	SHAREHOLDER_YIELD_PCT_RANGE: [-5.0, 2.0, 8.0],
	UPSIDE_RANGE: [-20.0, 15.0, 50.0],
	PROBABILITY_RANGE: [0.5, 0.55, 0.6],
	RATING_RANGE: [1.0, 3.5, 5.0],
} as const satisfies Record<string, MinMedMax>;

/** Multipliers tune stat contribution strength before averaging available valuation stats. */
export const ValuationMultipliers = {
	PEG: 2,
	PE: 1,
	PE_FORWARD: 0.75,
	DEBT_TO_EQUITY: 0.5,
	FCF_YIELD: 0.75,
	SHAREHOLDER_YIELD: 0.5,
	OPERATING_MARGIN: 1.25,
	ROIC: 0.75,
} as const;

/** Multipliers tune stat contribution strength before averaging available quality stats. */
export const QualitySignalMultipliers = {
	REVENUE_GROWTH: 1.2,
	GROSS_MARGIN: 1,
	OPERATING_MARGIN: 1.4,
	ROIC: 0.4,
	SHAREHOLDER_YIELD: 0.6,
} as const;

/** Strategy weights for 'Core' portfolio bucket (Quality & Moat focused). */
export const CoreEngineWeights = {
	MOAT: 0.35,
	QUALITY: 0.35,
	VALUATION: 0.15,
	SIZE: 0.1,
	EDGE: 0.05,
} as const;

/** Strategy weights for 'Satellite' portfolio bucket (Growth & Upside focused). */
export const SatelliteWeights = {
	MOAT: 0.3,
	QUALITY: 0.25,
	UPSIDE: 0.25,
	VALUATION: 0.1,
	EDGE: 0.1,
} as const;

/** Strategy weights for 'Speculative' portfolio bucket (High upside, lower core). */
export const SpeculativeWeights = {
	UPSIDE: 0.45,
	QUALITY: 0.2,
	MOAT: 0.2,
	VALUATION: 0.15,
} as const;

/** Strategy weights for 'Diversifier' portfolio bucket (Balanced defensive). */
export const DiversifierWeights = {
	QUALITY: 0.45,
	VALUATION: 0.25,
	SIZE: 0.2,
	UPSIDE: 0.1,
} as const;

/** Various thresholds and parameters for signal detection and LLM behavior. */
export const ThresholdConfig = {
	UPSIDE_MAX_PCT: 50,
	FOMO_VALUATION: 3,
	FOMO_UPSIDE: 8,
	FOMO_BULL: 5.8,
	WEB_SEARCH_MAX_RESULTS: 5,
	DIRECTION_CHANGE_DIVISOR: 10,
	DIRECTION_BASE_SCORE: 5,
} as const;

/** Thresholds for categorizing the 'Edge' level (conviction) of a setup. */
export const GameTierThresholds = {
	RARE_DISLOCATION: 6.8,
	SMURFING_MIN: 6.3,
	SMURFING_MAX: 6.7,
	VERY_HIGH_MIN: 5.9,
	VERY_HIGH_MAX: 6.2,
	HIGH_EDGE_MIN: 5.5,
	HIGH_EDGE_MAX: 5.8,
} as const;
