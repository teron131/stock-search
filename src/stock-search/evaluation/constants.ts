/** Define evaluation scoring defaults and calibration settings. */

export const BILLION = 1e9;
export const TRILLION = 1e12;

export type MinMedMax = [number, number, number];

export const DEFAULT_SCORE = 5;

export const SCORE_SCALE = 10;
export const MOAT_RESEARCH_WEIGHT = 0.7;
export const MOAT_SIGNAL_WEIGHT = 0.3;
export const QUALITY_RESEARCH_WEIGHT = 0.7;
export const QUALITY_SIGNAL_WEIGHT = 0.3;

export type StrategyBucket = {
	scoreKeys: [string, string, string, string];
	weights: [number, number, number, number];
	invertFlags: [boolean, boolean, boolean, boolean];
};

/** Configuration for mapping market capitalization values (Log-S-curve). */
export const MarketCapConfig = {
	MIN: 10 * BILLION,
	MEDIAN: 800 * BILLION,
	MAX: 4.5 * TRILLION,
} as const;

/** Calibration ranges for mapping various financial metrics to 0-10 scores. */
export const CalibrationConfig = {
	PEG_RANGE: [0.6, 2.0, 5.0],
	PE_RANGE: [10.0, 30.0, 85.0],
	PE_FORWARD_RANGE: [8.0, 28.0, 65.0],
	PS_RANGE: [1.0, 6.0, 25.0],
	PS_FORWARD_RANGE: [1.0, 5.0, 22.0],
	GROWTH_RANGE: [0.1, 0.3, 0.5],
	REVENUE_RANGE: [5 * BILLION, 100 * BILLION, 700 * BILLION],
	REVENUE_GROWTH_PCT_RANGE: [-15.0, 15.0, 70.0],
	EPS_GROWTH_PCT_RANGE: [-30.0, 15.0, 100.0],
	GROSS_MARGIN_PCT_RANGE: [10.0, 60.0, 90.0],
	OPERATING_MARGIN_PCT_RANGE: [-10.0, 30.0, 55.0],
	ROE_PCT_RANGE: [0.0, 25.0, 80.0],
	ROIC_PCT_RANGE: [0.0, 25.0, 80.0],
	DEBT_TO_EQUITY_PCT_RANGE: [0.0, 0.8, 3.0],
	FREE_CASH_FLOW_RANGE: [0.0, 10 * BILLION, 120 * BILLION],
	FCF_YIELD_PCT_RANGE: [-5.0, 4.0, 12.0],
	SHAREHOLDER_YIELD_PCT_RANGE: [-5.0, 3.0, 10.0],
	UPSIDE_RANGE: [-25.0, 15.0, 60.0],
	RATING_RANGE: [1.0, 3.5, 5.0],
} as const satisfies Record<string, MinMedMax>;

/** Multipliers tune stat contribution strength before averaging available valuation stats. */
export const ValuationMultipliers = {
	PEG: 2,
	PE: 1,
	PE_FORWARD: 1.5,
	FCF_YIELD: 1,
	SHAREHOLDER_YIELD: 0.5,
	DEBT_TO_EQUITY: 0.5,
	OPERATING_MARGIN: 0.5,
	ROIC: 0.5,
	SIZE: 1,
	REVENUE_SCALE: 0.5,
	EPS_GROWTH: 0.5,
} as const;

/** Multipliers tune stat contribution strength before averaging available quality stats. */
export const QualitySignalMultipliers = {
	REVENUE_SCALE: 1,
	REVENUE_GROWTH: 1.2,
	EPS_GROWTH: 1,
	FCF_SCALE: 1,
	GROSS_MARGIN: 1,
	OPERATING_MARGIN: 1,
	ROE: 1,
	ROIC: 1,
	SHAREHOLDER_YIELD: 0.5,
} as const;

/** Multipliers tune stat contribution strength before averaging available moat stats. */
export const MoatSignalMultipliers = {
	REVENUE_SCALE: 1,
	FCF_SCALE: 0.75,
	GROSS_MARGIN: 1.5,
	OPERATING_MARGIN: 1.5,
	ROE: 0.5,
	ROIC: 1.5,
	DEBT_TO_EQUITY: 0.5,
} as const;

/** Multipliers tune the raw growth and analyst channels in upside scoring. */
export const UpsideMultipliers = {
	REVENUE_GROWTH: 1,
	EPS_GROWTH: 1,
	MEDIAN_UPSIDE: 0.75,
	RATING: 0.5,
} as const;

/** Strategy weights for 'Core' portfolio bucket (Quality & Moat focused). */
export const CoreEngineWeights = {
	MOAT: 0.3,
	QUALITY: 0.3,
	VALUATION: 0.1,
	SIZE: 0.3,
} as const;

/** Strategy weights for 'Satellite' portfolio bucket (Growth & Upside focused). */
export const SatelliteWeights = {
	MOAT: 0.25,
	QUALITY: 0.25,
	UPSIDE: 0.25,
	VALUATION: 0.25,
} as const;

/** Strategy weights for 'Speculative' portfolio bucket (High upside, lower core). */
export const SpeculativeWeights = {
	UPSIDE: 0.5,
	QUALITY: 0.2,
	MOAT: 0.2,
	VALUATION: 0.1,
} as const;

/** Strategy weights for 'Diversifier' portfolio bucket (Balanced defensive). */
export const DiversifierWeights = {
	QUALITY: 0.4,
	VALUATION: 0.3,
	SIZE: 0.2,
	UPSIDE: 0.1,
} as const;

/** Various thresholds and parameters for signal detection and LLM behavior. */
export const ThresholdConfig = {
	UPSIDE_MAX_PCT: 50,
	WEB_SEARCH_MAX_RESULTS: 5,
} as const;
