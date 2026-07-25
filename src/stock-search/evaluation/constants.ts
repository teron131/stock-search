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
  RD_KNOWLEDGE_CAPITAL_RANGE: [0.5 * BILLION, 3 * BILLION, 10 * BILLION],
  RD_INTENSITY_PCT_RANGE: [2.0, 10.0, 18.0],
  UPSIDE_RANGE: [-25.0, 15.0, 60.0],
  RATING_RANGE: [1.0, 3.5, 5.0],
} as const satisfies Record<string, MinMedMax>;

/** Multipliers tune stat contribution strength before averaging available valuation stats. */
export const ValuationMultipliers = {
  PEG: 1.5,
  PE: 1,
  PE_FORWARD: 1.5,
  FCF_YIELD: 1,
  SHAREHOLDER_YIELD: 0.5,
  DEBT_TO_EQUITY: 0.5,
  OPERATING_MARGIN: 0.5,
  ROIC: 0.5,
  SIZE: 0.5,
  REVENUE_SCALE: 0.4,
  EPS_GROWTH: 0.25,
} as const;

/** Caps high valuation scores when cycle-sensitive cheapness also has a hot tactical setup. */
export const CycleValuationGuardConfig = {
  CYCLE_RISK_MIN: 0.45,
  TACTICAL_SETUP_MIN: 8,
  VALUATION_MIN: 7.5,
  CAP: 7.2,
  SEVERE_TACTICAL_SETUP_MIN: 8.5,
  SEVERE_VALUATION_MIN: 8.5,
  SEVERE_CAP: 7.8,
} as const;

/** Blend current and normalized cash yield so one capex/working-capital year does not dominate valuation. */
export const FcfYieldBlendConfig = {
  CURRENT_WEIGHT: 0.6,
  NORMALIZED_WEIGHT: 0.4,
} as const;

/** Direct EPS-growth support should not make peak-cycle valuation look permanently cheap. */
export const ValuationSignalConfig = {
  MAX_SINGLE_YEAR_EPS_GROWTH_SCORE: 7,
} as const;

/**
 * Warranted-FPE constants are intentionally conservative.
 *
 * BASE_FPE = 18 means a decent above-average business earns a neutral valuation score at roughly 18x forward earnings before quality/growth/moat premia.
 * Moat gets the largest premium sensitivity because durable competitive advantage extends cash-flow duration. Quality and durable growth get slightly smaller premia because they are partly reflected in profitability and current valuation metrics already.
 * Peak-cycle risk receives a larger negative multiplier because current-cycle earnings spikes can make cyclical stocks look falsely cheap. The final FPE score uses log2(warranted / actual): fair value maps to 5, a 2x undervaluation maps to 7.5, and a 2x overvaluation maps to 2.5.
 */
export const WarrantedFpeConfig = {
  BASE_FPE: 18,
  MOAT_SENSITIVITY: 0.05,
  QUALITY_SENSITIVITY: 0.04,
  GROWTH_SENSITIVITY: 0.04,
  PEAK_CYCLE_DISCOUNT: 0.35,
  RATIO_SCORE_SLOPE: 2.5,
  LEGACY_WEIGHT: 0.55,
  WARRANTED_FPE_WEIGHT: 0.45,
} as const;

/** Generic overheat signals dampen scores when recent fundamentals and price action look stretched. */
export const OverheatSignalConfig = {
  REVENUE_GROWTH_START: 50,
  REVENUE_GROWTH_FULL: 120,
  EPS_GROWTH_START: 100,
  EPS_GROWTH_FULL: 350,
  PRICE_1Y_START: 150,
  PRICE_1Y_FULL: 500,
  RSI_START: 75,
  RSI_FULL: 90,
  IV_START: 70,
  IV_FULL: 100,
  MIN_SIGNALS: 2,
  QUALITY_PENALTY: 0.75,
  VALUATION_PULL_TO_NEUTRAL: 0.3,
  UPSIDE_PENALTY: 1.25,
} as const;

/** Peak-cycle caps look through current earnings when the setup looks stretched. */
export const CycleNormalizationConfig = {
  HIGH_RISK: 0.65,
  SEVERE_RISK: 0.8,
  NO_TREND_MOAT_CAP_RISK: 0.25,
  NO_TREND_MOAT_CAP: 8.2,
  HIGH_RISK_MOAT_CAP: 7.5,
  HIGH_RISK_QUALITY_CAP: 7.3,
  HIGH_RISK_VALUATION_CAP: 6.8,
  HIGH_RISK_UPSIDE_CAP: 7,
  HIGH_RISK_OVERALL_CAP: 7.8,
  SEVERE_RISK_OVERALL_CAP: 7,
  NO_TREND_DURABLE_GROWTH_CAP_RISK: 0.6,
  NO_TREND_DURABLE_GROWTH_CAP: 6.5,
  GROWTH_SPIKE_START: 25,
  GROWTH_SPIKE_FULL: 120,
  MARGIN_SPIKE_START: 5,
  MARGIN_SPIKE_FULL: 25,
  MARGIN_STD_MEDIAN: 12,
  MARGIN_STD_WEAK: 35,
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

/** Single-year growth is useful evidence, but should not become a perfect durability signal. */
export const QualitySignalConfig = {
  MAX_SINGLE_YEAR_GROWTH_SCORE: 8.5,
  CURRENT_WEIGHT: 0.55,
  MARGIN_PERSISTENCE_WEIGHT: 0.2,
  FCF_MARGIN_WEIGHT: 0.1,
  SHARES_DISCIPLINE_WEIGHT: 0.1,
  STABILITY_WEIGHT: 0.05,
  CYCLE_FLOOR_RISK_MIN: 0.65,
  CYCLE_FLOOR_CURRENT_QUALITY_MIN: 7,
  CYCLE_FLOOR_MARGIN_PERSISTENCE_MIN: 5,
  CYCLE_FLOOR: 5,
} as const;

/** Multipliers tune stat contribution strength before averaging available moat stats. */
export const MoatSignalMultipliers = {
  REVENUE_SCALE: 0.75,
  FCF_SCALE: 0.75,
  GROSS_MARGIN: 0.75,
  OPERATING_MARGIN: 0.75,
  ROE: 0.3,
  ROIC: 0.75,
  DEBT_TO_EQUITY: 0.3,
  RD_KNOWLEDGE_CAPITAL: 0.5,
  RD_PRODUCTIVITY: 0.75,
  MARGIN_PERSISTENCE: 1.5,
  ROIC_PERSISTENCE: 1.25,
  SCALE_PERSISTENCE: 1,
  CAPITAL_PRODUCTIVITY: 0.75,
} as const;

/** Moat blends visible economic proof with structural persistence proxies. */
export const MoatBlendConfig = {
  ECONOMIC_WEIGHT: 0.45,
  STRUCTURAL_WEIGHT: 0.55,
} as const;

/** Multipliers tune the raw growth and analyst channels in upside scoring. */
export const UpsideMultipliers = {
  REVENUE_GROWTH: 1,
  EPS_GROWTH: 1,
  MEDIAN_UPSIDE: 0.75,
  RATING: 0.5,
} as const;

/** Caps for cases where growth is strong but analyst target gap is already negative. */
export const UpsideSupportConfig = {
  NEGATIVE_TARGET_GAP_CAP: 6,
  DEEP_NEGATIVE_TARGET_GAP: -25,
  DEEP_NEGATIVE_TARGET_GAP_CAP: 4.5,
  LOW_VALUATION_TRUST: 3.5,
  LOW_VALUATION_HIGH_UPSIDE_CAP: 7.5,
  MATURE_TACTICAL_MAX: 4,
  MATURE_REVENUE_GROWTH_MAX: 8,
  MATURE_UPSIDE_MAX: 7,
  MATURE_UPSIDE_CAP: 5.5,
} as const;

/** Quality-backed valuation floors prevent elite economics from scoring as broken without rescuing unprofitable rows. */
export const QualityBackedValuationFloorConfig = {
  ELITE_MOAT_MIN: 8,
  ELITE_QUALITY_MIN: 8,
  ELITE_FLOOR: 4.5,
  STRONG_MOAT_MIN: 7,
  STRONG_QUALITY_MIN: 7,
  STRONG_FLOOR: 4,
} as const;

/** Multipliers for short-to-medium-term setup separate from durable scoring. */
export const TacticalScoreMultipliers = {
  PRICE_MOMENTUM_1Y: 1.25,
  PRICE_MOMENTUM_6M: 0.75,
  REVENUE_GROWTH: 1,
  EPS_GROWTH: 1,
  VALUATION: 0.75,
  MEDIAN_UPSIDE: 0.5,
  RSI_ACTIVITY: 0.25,
  IV_ACTIVITY: 0.25,
} as const;

/** Weights for the public overall score. */
export const OverallScoreWeights = {
  MOAT: 0.35,
  QUALITY: 0.3,
  VALUATION: 0.2,
  UPSIDE: 0.15,
} as const;

/** Penalty strength for weak moat, quality, or valuation bottlenecks. */
export const OverallScoreConfig = {
  BOTTLENECK_PENALTY: 0.25,
} as const;

/** Absolute score gates keep role labels from overstating weak rows. */
export const StrategyGateConfig = {
  CORE_OVERALL_MIN: 7,
  CORE_MOAT_MIN: 7,
  CORE_QUALITY_MIN: 7,
  CORE_VALUATION_MIN: 3.5,
  SATELLITE_OVERALL_MIN: 5.5,
  SATELLITE_UPSIDE_MIN: 6.2,
  SATELLITE_TACTICAL_MIN: 5.5,
  SATELLITE_MOAT_MIN: 4,
  SATELLITE_QUALITY_MIN: 4,
  SATELLITE_VALUATION_MIN: 3,
  DEFENSE_OVERALL_MIN: 5,
  DEFENSE_QUALITY_MIN: 5,
  DEFENSE_VALUATION_MIN: 4,
  DEFENSE_SIZE_MIN: 6,
  STABLE_DEFENSE_MOAT_MIN: 6,
  STABLE_DEFENSE_QUALITY_MIN: 5,
  STABLE_DEFENSE_VALUATION_MIN: 3,
  STABLE_DEFENSE_TACTICAL_MAX: 4.5,
  STABLE_DEFENSE_UPSIDE_MAX: 6.2,
  SPECULATION_OVERALL_MAX: 4,
  SPECULATION_MOAT_MAX: 4,
  SPECULATION_QUALITY_MAX: 4,
  SPECULATION_VALUATION_MAX: 2.5,
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
