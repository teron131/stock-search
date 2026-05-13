/** Compute normalized factor scores from stock indicators. */

import { asNumber } from "../utils.js";
import {
	getScoreAnchors,
	getValuationScoreAnchors,
	type ScoreAnchorKey,
	type ScoreAnchors,
} from "./anchors.js";
import {
	CalibrationConfig,
	CoreEngineWeights,
	CycleNormalizationConfig,
	CycleValuationGuardConfig,
	DEFAULT_SCORE,
	DiversifierWeights,
	FcfYieldBlendConfig,
	MoatBlendConfig,
	MoatSignalMultipliers,
	OverallScoreConfig,
	OverallScoreWeights,
	OverheatSignalConfig,
	QualityBackedValuationFloorConfig,
	QualitySignalConfig,
	QualitySignalMultipliers,
	SatelliteWeights,
	SCORE_SCALE,
	SpeculativeWeights,
	type StrategyBucket,
	TacticalScoreMultipliers,
	UpsideMultipliers,
	UpsideSupportConfig,
	ValuationMultipliers,
	ValuationSignalConfig,
	WarrantedFpeConfig,
} from "./constants.js";
import { clampScore, mapToCurveScore } from "./math-utils.js";

type WeightedFactorConfig = [
	number | null,
	[number, number, number],
	number,
	boolean,
];
type IndicatorLike = Record<string, unknown>;

const NORMALIZED_SCORE_RANGE: [number, number, number] = [
	0,
	SCORE_SCALE / 2,
	SCORE_SCALE,
];
const MIN_UPSIDE_RAW_COMPONENTS = 2;
const WEAK_SUPPORT_UPSIDE_CAP = 6;
const VERY_WEAK_SUPPORT_UPSIDE_CAP = 4;

const STRATEGY_BUCKETS: Record<string, StrategyBucket> = {
	core: {
		scoreKeys: ["moat_score", "quality_score", "valuation_score", "size_score"],
		weights: [
			CoreEngineWeights.MOAT,
			CoreEngineWeights.QUALITY,
			CoreEngineWeights.VALUATION,
			CoreEngineWeights.SIZE,
		],
		invertFlags: [false, false, false, false],
	},
	satellite: {
		scoreKeys: [
			"moat_score",
			"quality_score",
			"valuation_score",
			"upside_score",
		],
		weights: [
			SatelliteWeights.MOAT,
			SatelliteWeights.QUALITY,
			SatelliteWeights.VALUATION,
			SatelliteWeights.UPSIDE,
		],
		invertFlags: [false, false, false, false],
	},
	speculative: {
		scoreKeys: [
			"upside_score",
			"quality_score",
			"moat_score",
			"valuation_score",
		],
		weights: [
			SpeculativeWeights.UPSIDE,
			SpeculativeWeights.QUALITY,
			SpeculativeWeights.MOAT,
			SpeculativeWeights.VALUATION,
		],
		invertFlags: [false, true, true, true],
	},
	diversifier: {
		scoreKeys: [
			"quality_score",
			"valuation_score",
			"size_score",
			"upside_score",
		],
		weights: [
			DiversifierWeights.QUALITY,
			DiversifierWeights.VALUATION,
			DiversifierWeights.SIZE,
			DiversifierWeights.UPSIDE,
		],
		invertFlags: [false, false, false, true],
	},
};

function getNumberField(
	indicator: IndicatorLike,
	fieldName: string,
): number | null {
	return asNumber(indicator[fieldName]);
}

function canonicalMarketCap(indicator: IndicatorLike): number | null {
	return getNumberField(indicator, "market_cap");
}

function valuationMultipleField(
	indicator: IndicatorLike,
	fieldName: string,
	[, , weakAnchor]: [number, number, number],
): number | null {
	const value = getNumberField(indicator, fieldName);
	return value == null ? null : value <= 0 ? weakAnchor : value;
}

function anchorRange(
	anchorKey: ScoreAnchorKey,
	anchors: ScoreAnchors = getScoreAnchors(),
): [number, number, number] {
	return anchors[anchorKey];
}

function statCurveScore(
	value: number | null,
	anchorKey: ScoreAnchorKey,
	inverse = false,
): number | null {
	if (value == null) {
		return null;
	}
	const [rangeMin, rangeMedian, rangeMax] = anchorRange(anchorKey);
	return mapToCurveScore(value, rangeMin, rangeMax, rangeMedian, {
		outMin: inverse ? SCORE_SCALE : 0,
		outMax: inverse ? 0 : SCORE_SCALE,
	});
}

function qualityGrowthScore(
	value: number | null,
	anchorKey: "revenue_growth" | "eps_growth",
): number | null {
	const score = statCurveScore(value, anchorKey);
	return score == null
		? null
		: Math.min(score, QualitySignalConfig.MAX_SINGLE_YEAR_GROWTH_SCORE);
}

function valuationEpsGrowthScore(value: number | null): number | null {
	const score = statCurveScore(value, "eps_growth");
	return score == null
		? null
		: Math.min(score, ValuationSignalConfig.MAX_SINGLE_YEAR_EPS_GROWTH_SCORE);
}

function tacticalGrowthScore(
	value: number | null,
	anchorKey: "revenue_growth" | "eps_growth",
): number | null {
	const score = statCurveScore(value, anchorKey);
	return score == null ? null : Math.min(score, SCORE_SCALE);
}

function tacticalMomentumScore(value: number | null): number | null {
	return value == null
		? null
		: mapToCurveScore(value, -50, 250, 50, {
				outMin: 0,
				outMax: SCORE_SCALE,
			});
}

function tacticalActivityScore(
	value: number | null,
	range: [number, number, number],
): number | null {
	if (value == null) {
		return null;
	}
	const [rangeMin, rangeMedian, rangeMax] = range;
	return mapToCurveScore(value, rangeMin, rangeMax, rangeMedian);
}

function rampSignal(
	value: number | null,
	start: number,
	full: number,
): number | null {
	if (value == null) {
		return null;
	}
	if (value <= start) {
		return 0;
	}
	if (value >= full) {
		return 1;
	}
	return (value - start) / (full - start);
}

function inverseRampSignal(
	value: number | null,
	start: number,
	full: number,
): number | null {
	if (value == null) {
		return null;
	}
	if (value >= start) {
		return 0;
	}
	if (value <= full) {
		return 1;
	}
	return (start - value) / (start - full);
}

function weightedMeanUnit(factors: Array<[number | null, number]>): number {
	const availableFactors = factors.filter(
		(factor): factor is [number, number] => factor[0] != null,
	);
	const totalWeight = availableFactors.reduce(
		(sum, [, weight]) => sum + weight,
		0,
	);
	if (availableFactors.length === 0 || totalWeight <= 0) {
		return 0;
	}
	return Math.max(
		0,
		Math.min(
			1,
			availableFactors.reduce(
				(sum, [score, weight]) => sum + score * weight,
				0,
			) / totalWeight,
		),
	);
}

function overheatRisk(indicator: IndicatorLike): number {
	const signals = [
		rampSignal(
			getNumberField(indicator, "revenue_growth"),
			OverheatSignalConfig.REVENUE_GROWTH_START,
			OverheatSignalConfig.REVENUE_GROWTH_FULL,
		),
		rampSignal(
			getNumberField(indicator, "eps_growth"),
			OverheatSignalConfig.EPS_GROWTH_START,
			OverheatSignalConfig.EPS_GROWTH_FULL,
		),
		rampSignal(
			getNumberField(indicator, "change_percent_1y"),
			OverheatSignalConfig.PRICE_1Y_START,
			OverheatSignalConfig.PRICE_1Y_FULL,
		),
		rampSignal(
			getNumberField(indicator, "rsi"),
			OverheatSignalConfig.RSI_START,
			OverheatSignalConfig.RSI_FULL,
		),
		rampSignal(
			getNumberField(indicator, "iv"),
			OverheatSignalConfig.IV_START,
			OverheatSignalConfig.IV_FULL,
		),
	].filter((signal): signal is number => signal != null);
	const activeSignals = signals.filter((signal) => signal > 0);
	if (activeSignals.length < OverheatSignalConfig.MIN_SIGNALS) {
		return 0;
	}
	return (
		activeSignals.reduce((sum, signal) => sum + signal, 0) / signals.length
	);
}

function hasTrendHistory(indicator: IndicatorLike): boolean {
	return [
		"revenue_growth_1y",
		"revenue_cagr_3y",
		"fcf_growth_1y",
		"fcf_cagr_3y",
		"gross_margin_median_3y",
		"operating_margin_median_3y",
		"operating_margin_std_3y",
		"fcf_margin_median_3y",
		"shares_change_1y",
		"shares_change_cagr_3y",
	].some((fieldName) => getNumberField(indicator, fieldName) != null);
}

export function calculatePeakCycleRisk(indicator: IndicatorLike): number {
	const revenueGrowth1y =
		getNumberField(indicator, "revenue_growth_1y") ??
		getNumberField(indicator, "revenue_growth");
	const revenueTrend = getNumberField(indicator, "revenue_cagr_3y");
	const revenueSpikeVsTrend =
		revenueGrowth1y == null || revenueTrend == null
			? null
			: revenueGrowth1y - revenueTrend;
	const fcfGrowth1y = getNumberField(indicator, "fcf_growth_1y");
	const fcfTrend = getNumberField(indicator, "fcf_cagr_3y");
	const fcfSpikeVsTrend =
		fcfGrowth1y == null || fcfTrend == null ? null : fcfGrowth1y - fcfTrend;
	const revenueGrowthSpike = rampSignal(
		revenueSpikeVsTrend,
		CycleNormalizationConfig.GROWTH_SPIKE_START,
		CycleNormalizationConfig.GROWTH_SPIKE_FULL,
	);
	const fcfGrowthSpike = rampSignal(
		fcfSpikeVsTrend,
		CycleNormalizationConfig.GROWTH_SPIKE_START,
		CycleNormalizationConfig.GROWTH_SPIKE_FULL,
	);
	const growthSpike =
		revenueGrowthSpike == null && fcfGrowthSpike == null
			? null
			: weightedMeanUnit([
					[revenueGrowthSpike, 0.7],
					[fcfGrowthSpike, 0.3],
				]);
	const marginSpike = rampSignal(
		getNumberField(indicator, "operating_margin_delta_vs_3y"),
		CycleNormalizationConfig.MARGIN_SPIKE_START,
		CycleNormalizationConfig.MARGIN_SPIKE_FULL,
	);
	const marginVolatility = rampSignal(
		getNumberField(indicator, "operating_margin_std_3y"),
		CycleNormalizationConfig.MARGIN_STD_MEDIAN,
		CycleNormalizationConfig.MARGIN_STD_WEAK,
	);
	const earningsSpike = rampSignal(
		getNumberField(indicator, "eps_growth"),
		OverheatSignalConfig.EPS_GROWTH_START,
		OverheatSignalConfig.EPS_GROWTH_FULL,
	);
	const priceSpike = rampSignal(
		getNumberField(indicator, "change_percent_1y"),
		OverheatSignalConfig.PRICE_1Y_START,
		OverheatSignalConfig.PRICE_1Y_FULL,
	);
	const rsiSpike = rampSignal(
		getNumberField(indicator, "rsi"),
		OverheatSignalConfig.RSI_START,
		OverheatSignalConfig.RSI_FULL,
	);
	const ivSpike = rampSignal(
		getNumberField(indicator, "iv"),
		OverheatSignalConfig.IV_START,
		OverheatSignalConfig.IV_FULL,
	);
	const cheapForwardPe = inverseRampSignal(
		getNumberField(indicator, "pe_forward"),
		18,
		8,
	);
	const cheapPeg = inverseRampSignal(getNumberField(indicator, "peg"), 1, 0.2);
	const earningsSpikeValue = earningsSpike ?? 0;
	const growthSpikeValue = growthSpike ?? 0;
	const earningsGrowthOrPriceSpikeValue = Math.max(
		earningsSpikeValue,
		growthSpikeValue,
		priceSpike ?? 0,
	);
	const falseCheapness = Math.max(
		(cheapForwardPe ?? 0) * Math.max(earningsSpikeValue, growthSpikeValue),
		(cheapPeg ?? 0) * earningsGrowthOrPriceSpikeValue,
	);

	return weightedMeanUnit([
		[growthSpike, 0.3],
		[marginSpike, 0.2],
		[falseCheapness, 0.35],
		[priceSpike, 0.15],
		[ivSpike, 0.1],
		[rsiSpike, 0.05],
		[marginVolatility, 0.1],
	]);
}

function pullScoreTowardNeutral(score: number, risk: number): number {
	if (score <= DEFAULT_SCORE || risk <= 0) {
		return score;
	}
	return (
		score -
		(score - DEFAULT_SCORE) *
			risk *
			OverheatSignalConfig.VALUATION_PULL_TO_NEUTRAL
	);
}

function scaleScore(
	value: number | null,
	anchorKey: ScoreAnchorKey,
): number | null {
	if (value == null) {
		return null;
	}
	if (value <= 0) {
		return 0;
	}
	const [rangeMin, rangeMedian, rangeMax] = anchorRange(anchorKey);
	return mapToCurveScore(
		Math.log10(value),
		Math.log10(rangeMin),
		Math.log10(rangeMax),
		Math.log10(rangeMedian),
	);
}

function weightedMeanStatScore(factors: WeightedFactorConfig[]): number | null {
	const weightedScores: number[] = [];
	const weights: number[] = [];

	for (const [value, inputRange, multiplier, inverse] of factors) {
		if (value == null) {
			continue;
		}
		const [rangeMin, rangeMedian, rangeMax] = inputRange;
		const score = mapToCurveScore(value, rangeMin, rangeMax, rangeMedian, {
			outMin: inverse ? SCORE_SCALE : 0,
			outMax: inverse ? 0 : SCORE_SCALE,
		});
		weightedScores.push(score * multiplier);
		weights.push(multiplier);
	}

	const totalWeight = weights.reduce((sum, value) => sum + value, 0);
	if (weightedScores.length === 0 || totalWeight <= 0) {
		return null;
	}
	return clampScore(
		weightedScores.reduce((sum, value) => sum + value, 0) / totalWeight,
	);
}

function weightedMeanScore(
	factors: Array<[number | null, number]>,
): number | null {
	const availableFactors = factors.filter(
		(factor): factor is [number, number] => factor[0] != null,
	);
	const totalWeight = availableFactors.reduce(
		(sum, [, weight]) => sum + weight,
		0,
	);
	if (availableFactors.length === 0 || totalWeight <= 0) {
		return null;
	}
	return clampScore(
		availableFactors.reduce((sum, [score, weight]) => sum + score * weight, 0) /
			totalWeight,
	);
}

function finiteScore(value: number | null | undefined): number | null {
	return value == null || !Number.isFinite(value) ? null : value;
}

function scoreOrNeutral(value: number | null | undefined): number {
	return finiteScore(value) ?? DEFAULT_SCORE;
}

function isBankLike(indicator: IndicatorLike): boolean {
	const sector =
		typeof indicator.sector_name === "string"
			? indicator.sector_name.toLowerCase()
			: "";
	const industry =
		typeof indicator.industry_name === "string"
			? indicator.industry_name.toLowerCase()
			: "";
	return (
		sector.includes("financial") ||
		industry.includes("bank") ||
		industry.includes("capital markets") ||
		industry.includes("insurance")
	);
}

/** Compute the public overall score with weak core fundamentals treated as bottlenecks. */
export function calculateOverallScore(
	scores: Record<string, number | null | undefined>,
	cycleRisk = 0,
): number | null {
	const coreScores = [
		finiteScore(scores.moat_score),
		finiteScore(scores.quality_score),
		finiteScore(scores.valuation_score),
		finiteScore(scores.upside_score),
	];
	if (coreScores.every((score) => score == null)) {
		return null;
	}

	const weightedScore =
		scoreOrNeutral(scores.moat_score) * OverallScoreWeights.MOAT +
		scoreOrNeutral(scores.quality_score) * OverallScoreWeights.QUALITY +
		scoreOrNeutral(scores.valuation_score) * OverallScoreWeights.VALUATION +
		scoreOrNeutral(scores.upside_score) * OverallScoreWeights.UPSIDE;
	const weakestCoreScore = Math.min(
		scoreOrNeutral(scores.moat_score),
		scoreOrNeutral(scores.quality_score),
		scoreOrNeutral(scores.valuation_score),
	);
	const bottleneckPenalty =
		Math.max(0, DEFAULT_SCORE - weakestCoreScore) *
		OverallScoreConfig.BOTTLENECK_PENALTY;

	const overallScore = clampScore(weightedScore - bottleneckPenalty);
	if (cycleRisk >= CycleNormalizationConfig.SEVERE_RISK) {
		return Math.min(
			overallScore,
			CycleNormalizationConfig.SEVERE_RISK_OVERALL_CAP,
		);
	}
	if (cycleRisk >= CycleNormalizationConfig.HIGH_RISK) {
		return Math.min(
			overallScore,
			CycleNormalizationConfig.HIGH_RISK_OVERALL_CAP,
		);
	}
	return overallScore;
}

function fcfYieldPercent(indicator: IndicatorLike): number | null {
	const marketCap = canonicalMarketCap(indicator);
	const freeCashFlow = getNumberField(indicator, "free_cash_flow");
	if (freeCashFlow == null || marketCap == null || marketCap <= 0) {
		return null;
	}
	return (freeCashFlow / marketCap) * 100;
}

function normalizedFcfYieldPercent(indicator: IndicatorLike): number | null {
	const marketCap = canonicalMarketCap(indicator);
	const revenue = getNumberField(indicator, "revenue");
	const fcfMarginMedian = getNumberField(indicator, "fcf_margin_median_3y");
	if (
		marketCap == null ||
		marketCap <= 0 ||
		revenue == null ||
		fcfMarginMedian == null
	) {
		return null;
	}
	return ((revenue * fcfMarginMedian) / 100 / marketCap) * 100;
}

function fcfYieldSupportScore(
	indicator: IndicatorLike,
	anchors: ScoreAnchors,
): number | null {
	if (isBankLike(indicator)) {
		return null;
	}
	const fcfYieldRange = anchorRange("fcf_yield", anchors);
	return weightedMeanStatScore([
		[
			fcfYieldPercent(indicator),
			fcfYieldRange,
			FcfYieldBlendConfig.CURRENT_WEIGHT,
			false,
		],
		[
			normalizedFcfYieldPercent(indicator),
			fcfYieldRange,
			FcfYieldBlendConfig.NORMALIZED_WEIGHT,
			false,
		],
	]);
}

function marginStabilityScore(value: number | null): number | null {
	return value == null
		? null
		: mapToCurveScore(
				value,
				0,
				CycleNormalizationConfig.MARGIN_STD_WEAK,
				CycleNormalizationConfig.MARGIN_STD_MEDIAN,
				{ outMin: SCORE_SCALE, outMax: 0 },
			);
}

function durableGrowthScore(indicator: IndicatorLike): number | null {
	const trendScore = weightedMeanScore([
		[
			statCurveScore(
				getNumberField(indicator, "revenue_growth_1y"),
				"revenue_growth",
			),
			0.25,
		],
		[
			statCurveScore(
				getNumberField(indicator, "revenue_cagr_3y"),
				"revenue_growth",
			),
			0.35,
		],
		[
			statCurveScore(
				getNumberField(indicator, "fcf_growth_1y"),
				"revenue_growth",
			),
			0.1,
		],
		[
			statCurveScore(
				getNumberField(indicator, "fcf_cagr_3y"),
				"revenue_growth",
			),
			0.2,
		],
		[
			marginStabilityScore(
				getNumberField(indicator, "operating_margin_std_3y"),
			),
			0.1,
		],
	]);
	if (trendScore != null) {
		return trendScore;
	}

	const marginScore = weightedMeanScore([
		[
			statCurveScore(getNumberField(indicator, "gross_margin"), "gross_margin"),
			0.4,
		],
		[
			statCurveScore(
				getNumberField(indicator, "operating_margin"),
				"operating_margin",
			),
			0.6,
		],
	]);
	const fallbackScore = weightedMeanScore([
		[
			qualityGrowthScore(
				getNumberField(indicator, "revenue_growth"),
				"revenue_growth",
			),
			0.6,
		],
		[
			qualityGrowthScore(getNumberField(indicator, "eps_growth"), "eps_growth"),
			0.25,
		],
		[marginScore, 0.15],
	]);
	if (fallbackScore == null) {
		return null;
	}
	if (
		!hasTrendHistory(indicator) &&
		calculatePeakCycleRisk(indicator) >=
			CycleNormalizationConfig.NO_TREND_DURABLE_GROWTH_CAP_RISK
	) {
		return Math.min(
			fallbackScore,
			CycleNormalizationConfig.NO_TREND_DURABLE_GROWTH_CAP,
		);
	}
	return fallbackScore;
}

function viableBusinessQualityFloor(indicator: IndicatorLike): number | null {
	const revenueGrowth = getNumberField(indicator, "revenue_growth");
	const epsGrowth = getNumberField(indicator, "eps_growth");
	const operatingMargin = getNumberField(indicator, "operating_margin");
	const roe = getNumberField(indicator, "roe");
	const roic = getNumberField(indicator, "roic");
	const grossMargin = getNumberField(indicator, "gross_margin");
	const freeCashFlowYield = fcfYieldPercent(indicator);

	const positiveSignals = [
		revenueGrowth != null && revenueGrowth > 0,
		epsGrowth != null && epsGrowth > 0,
		operatingMargin != null && operatingMargin > 0,
		roe != null && roe > 0,
		roic != null && roic > 0,
		grossMargin != null && grossMargin > 0,
		freeCashFlowYield != null && freeCashFlowYield > 0,
	].filter(Boolean).length;

	if (positiveSignals < 3) {
		return null;
	}

	if ((roic ?? 0) >= 25 && (operatingMargin ?? 0) > 0) {
		return 4;
	}
	if ((revenueGrowth ?? 0) >= 15 && (operatingMargin ?? 0) > 0) {
		return 3.5;
	}
	return 3;
}

function viableBusinessValuationFloor(
	indicator: IndicatorLike,
	anchors: ScoreAnchors,
): number | null {
	if (isBankLike(indicator)) {
		return null;
	}
	const forwardPe = getNumberField(indicator, "pe_forward");
	const debtToEquity = getNumberField(indicator, "debt_to_equity");
	const freeCashFlowYield = fcfYieldPercent(indicator);

	if (
		forwardPe != null &&
		forwardPe > 0 &&
		forwardPe <= anchorRange("pe_forward", anchors)[2] &&
		(debtToEquity == null ||
			debtToEquity <= anchorRange("debt_to_equity", anchors)[1]) &&
		freeCashFlowYield != null &&
		freeCashFlowYield > 0
	) {
		return 2;
	}

	return null;
}

function forwardPeForValuation(
	indicator: IndicatorLike,
	anchors: ScoreAnchors,
): number | null {
	const forwardPeRange = anchorRange("pe_forward", anchors);
	const forwardPe = valuationMultipleField(
		indicator,
		"pe_forward",
		forwardPeRange,
	);
	const operatingMargin = getNumberField(indicator, "operating_margin");
	const roic = getNumberField(indicator, "roic");
	const freeCashFlowYield = fcfYieldPercent(indicator);
	if (
		forwardPe != null &&
		operatingMargin != null &&
		operatingMargin <= 0 &&
		roic != null &&
		roic <= 0 &&
		freeCashFlowYield != null &&
		freeCashFlowYield <= 0
	) {
		return forwardPeRange[2];
	}
	return forwardPe;
}

function hasBrokenProfitability(indicator: IndicatorLike): boolean {
	const operatingMargin = getNumberField(indicator, "operating_margin");
	const roic = getNumberField(indicator, "roic");
	const freeCashFlowYield = fcfYieldPercent(indicator);
	return (
		operatingMargin != null &&
		operatingMargin <= 0 &&
		roic != null &&
		roic <= 0 &&
		freeCashFlowYield != null &&
		freeCashFlowYield <= 0
	);
}

function supportsQualityBackedValuationFloor(
	indicator: IndicatorLike,
): boolean {
	const freeCashFlow = getNumberField(indicator, "free_cash_flow");
	const operatingMargin = getNumberField(indicator, "operating_margin");
	const roic = getNumberField(indicator, "roic");
	return (
		freeCashFlow != null &&
		freeCashFlow > 0 &&
		operatingMargin != null &&
		operatingMargin > 0 &&
		roic != null &&
		roic > 0
	);
}

function qualityBackedValuationFloor(indicator: IndicatorLike): number | null {
	if (!supportsQualityBackedValuationFloor(indicator)) {
		return null;
	}
	const moatScore = calculateMoatSignalScore(indicator);
	const qualityScore = calculateQualitySignalScore(indicator);
	if (
		moatScore != null &&
		moatScore >= QualityBackedValuationFloorConfig.ELITE_MOAT_MIN &&
		qualityScore != null &&
		qualityScore >= QualityBackedValuationFloorConfig.ELITE_QUALITY_MIN
	) {
		return QualityBackedValuationFloorConfig.ELITE_FLOOR;
	}
	if (
		moatScore != null &&
		moatScore >= QualityBackedValuationFloorConfig.STRONG_MOAT_MIN &&
		qualityScore != null &&
		qualityScore >= QualityBackedValuationFloorConfig.STRONG_QUALITY_MIN
	) {
		return QualityBackedValuationFloorConfig.STRONG_FLOOR;
	}
	return null;
}

/** Map market cap to 1-10 using a Log-S-curve. */
export function marketCapScore(
	info: Record<string, unknown> | null | undefined = null,
): number | null {
	if (!info) {
		return null;
	}
	const marketCap =
		"marketCap" in info ? asNumber(info.marketCap) : canonicalMarketCap(info);
	const quoteType = info.quoteType ?? info.quote_type;
	if (quoteType === "ETF" || marketCap == null || marketCap <= 0) {
		return null;
	}

	return mapToCurveScore(
		Math.log10(marketCap),
		Math.log10(anchorRange("market_cap")[0]),
		Math.log10(anchorRange("market_cap")[2]),
		Math.log10(anchorRange("market_cap")[1]),
	);
}

function calculateLegacyValuationScore(
	indicator: IndicatorLike,
): number | null {
	const valuationAnchors = getValuationScoreAnchors(indicator);
	const pegRange = anchorRange("peg", valuationAnchors);
	const peRange = anchorRange("pe", valuationAnchors);
	const forwardPeRange = anchorRange("pe_forward", valuationAnchors);
	const debtToEquityRange = anchorRange("debt_to_equity", valuationAnchors);
	const fcfYieldRange = anchorRange("fcf_yield", valuationAnchors);
	const shareholderYieldRange = anchorRange(
		"shareholder_yield",
		valuationAnchors,
	);
	const operatingMarginRange = anchorRange(
		"operating_margin",
		valuationAnchors,
	);
	const roicRange = anchorRange("roic", valuationAnchors);
	const bankLike = isBankLike(indicator);

	const rawScore = weightedMeanStatScore([
		[
			valuationMultipleField(indicator, "peg", pegRange),
			pegRange,
			ValuationMultipliers.PEG,
			true,
		],
		[
			valuationMultipleField(indicator, "pe", peRange),
			peRange,
			ValuationMultipliers.PE,
			true,
		],
		[
			forwardPeForValuation(indicator, valuationAnchors),
			forwardPeRange,
			ValuationMultipliers.PE_FORWARD,
			true,
		],
		[
			bankLike ? null : getNumberField(indicator, "debt_to_equity"),
			debtToEquityRange,
			ValuationMultipliers.DEBT_TO_EQUITY,
			true,
		],
		[
			fcfYieldSupportScore(indicator, valuationAnchors),
			NORMALIZED_SCORE_RANGE,
			ValuationMultipliers.FCF_YIELD,
			false,
		],
		[
			getNumberField(indicator, "shareholder_yield"),
			shareholderYieldRange,
			ValuationMultipliers.SHAREHOLDER_YIELD,
			false,
		],
		[
			valuationEpsGrowthScore(getNumberField(indicator, "eps_growth")),
			NORMALIZED_SCORE_RANGE,
			ValuationMultipliers.EPS_GROWTH,
			false,
		],
		[
			getNumberField(indicator, "operating_margin"),
			operatingMarginRange,
			ValuationMultipliers.OPERATING_MARGIN,
			false,
		],
		[
			getNumberField(indicator, "roic"),
			roicRange,
			ValuationMultipliers.ROIC,
			false,
		],
		[
			marketCapScore(indicator),
			NORMALIZED_SCORE_RANGE,
			ValuationMultipliers.SIZE,
			false,
		],
		[
			scaleScore(getNumberField(indicator, "revenue"), "revenue"),
			NORMALIZED_SCORE_RANGE,
			ValuationMultipliers.REVENUE_SCALE,
			false,
		],
	]);
	const floor = viableBusinessValuationFloor(indicator, valuationAnchors);
	if (rawScore == null) {
		return floor;
	}
	const adjustedScore = pullScoreTowardNeutral(
		rawScore,
		overheatRisk(indicator),
	);
	return Math.max(adjustedScore, floor ?? adjustedScore);
}

function calculateWarrantedFpeScore(indicator: IndicatorLike): number | null {
	const actualForwardPe = getNumberField(indicator, "pe_forward");
	if (actualForwardPe == null || actualForwardPe <= 0) {
		return null;
	}
	if (hasBrokenProfitability(indicator)) {
		return null;
	}

	const moatScore = calculateMoatSignalScore(indicator);
	const qualityScore = calculateQualitySignalScore(indicator);
	const growthScore = durableGrowthScore(indicator);
	const risk = calculatePeakCycleRisk(indicator);
	const warrantedForwardPe =
		WarrantedFpeConfig.BASE_FPE *
		(1 +
			WarrantedFpeConfig.MOAT_SENSITIVITY * (scoreOrNeutral(moatScore) - 6)) *
		(1 +
			WarrantedFpeConfig.QUALITY_SENSITIVITY *
				(scoreOrNeutral(qualityScore) - 6)) *
		(1 +
			WarrantedFpeConfig.GROWTH_SENSITIVITY *
				(scoreOrNeutral(growthScore) - 5)) *
		(1 - WarrantedFpeConfig.PEAK_CYCLE_DISCOUNT * risk);

	if (warrantedForwardPe <= 0) {
		return null;
	}
	return clampScore(
		DEFAULT_SCORE +
			WarrantedFpeConfig.RATIO_SCORE_SLOPE *
				Math.log2(warrantedForwardPe / actualForwardPe),
	);
}

function applyHighCycleCap(
	score: number | null,
	risk: number,
	cap: number,
): number | null {
	if (score == null || risk < CycleNormalizationConfig.HIGH_RISK) {
		return score;
	}
	return Math.min(score, cap);
}

function tacticalSetupWithoutValuationScore(
	indicator: IndicatorLike,
): number | null {
	return weightedMeanScore([
		[
			tacticalMomentumScore(getNumberField(indicator, "change_percent_1y")),
			TacticalScoreMultipliers.PRICE_MOMENTUM_1Y,
		],
		[
			tacticalMomentumScore(getNumberField(indicator, "change_percent_6m")),
			TacticalScoreMultipliers.PRICE_MOMENTUM_6M,
		],
		[
			tacticalGrowthScore(
				getNumberField(indicator, "revenue_growth"),
				"revenue_growth",
			),
			TacticalScoreMultipliers.REVENUE_GROWTH,
		],
		[
			tacticalGrowthScore(
				getNumberField(indicator, "eps_growth"),
				"eps_growth",
			),
			TacticalScoreMultipliers.EPS_GROWTH,
		],
		[
			tacticalActivityScore(getNumberField(indicator, "rsi"), [30, 55, 85]),
			TacticalScoreMultipliers.RSI_ACTIVITY,
		],
		[
			tacticalActivityScore(getNumberField(indicator, "iv"), [20, 45, 90]),
			TacticalScoreMultipliers.IV_ACTIVITY,
		],
	]);
}

function applyCycleValuationGuard(
	score: number | null,
	indicator: IndicatorLike,
	cycleRisk: number,
): number | null {
	if (score == null) {
		return null;
	}
	const tacticalSetup = tacticalSetupWithoutValuationScore(indicator);
	if (
		score > CycleValuationGuardConfig.SEVERE_VALUATION_MIN &&
		(tacticalSetup ?? 0) > CycleValuationGuardConfig.SEVERE_TACTICAL_SETUP_MIN
	) {
		return Math.min(score, CycleValuationGuardConfig.SEVERE_CAP);
	}
	if (
		score > CycleValuationGuardConfig.VALUATION_MIN &&
		(tacticalSetup ?? 0) > CycleValuationGuardConfig.TACTICAL_SETUP_MIN &&
		cycleRisk >= CycleValuationGuardConfig.CYCLE_RISK_MIN
	) {
		return Math.min(score, CycleValuationGuardConfig.CAP);
	}
	return score;
}

/** Compute weighted valuation score from legacy factors and warranted FPE. */
export function calculateValuationScore(
	indicator: IndicatorLike,
): number | null {
	const legacyScore = calculateLegacyValuationScore(indicator);
	const warrantedFpeScore = calculateWarrantedFpeScore(indicator);
	const blendedScore = weightedMeanScore([
		[legacyScore, WarrantedFpeConfig.LEGACY_WEIGHT],
		[warrantedFpeScore, WarrantedFpeConfig.WARRANTED_FPE_WEIGHT],
	]);
	const qualityFloor = qualityBackedValuationFloor(indicator);
	const flooredScore =
		blendedScore == null || qualityFloor == null
			? blendedScore
			: Math.max(blendedScore, qualityFloor);
	const cycleRisk = calculatePeakCycleRisk(indicator);
	const guardedScore = applyCycleValuationGuard(
		flooredScore,
		indicator,
		cycleRisk,
	);
	return applyHighCycleCap(
		guardedScore,
		cycleRisk,
		CycleNormalizationConfig.HIGH_RISK_VALUATION_CAP,
	);
}

function marginPersistenceScore(indicator: IndicatorLike): number | null {
	const grossMarginMedian =
		getNumberField(indicator, "gross_margin_median_3y") ??
		getNumberField(indicator, "gross_margin");
	const operatingMarginMedian =
		getNumberField(indicator, "operating_margin_median_3y") ??
		getNumberField(indicator, "operating_margin");
	const fcfMarginMedian = getNumberField(indicator, "fcf_margin_median_3y");
	return weightedMeanScore([
		[
			grossMarginMedian == null
				? null
				: mapToCurveScore(grossMarginMedian, 20, 70, 45),
			0.25,
		],
		[
			operatingMarginMedian == null
				? null
				: mapToCurveScore(operatingMarginMedian, 5, 45, 25),
			0.35,
		],
		[
			fcfMarginMedian == null
				? null
				: mapToCurveScore(fcfMarginMedian, -5, 35, 15),
			0.25,
		],
		[
			marginStabilityScore(
				getNumberField(indicator, "operating_margin_std_3y"),
			),
			0.15,
		],
	]);
}

function usesComparableFinancialsCurrency(indicator: IndicatorLike): boolean {
	const currency = indicator.financials_currency;
	if (typeof currency !== "string" || !currency.trim()) {
		return true;
	}
	return new Set(["USD", "EUR", "GBP", "CHF", "CAD", "AUD"]).has(
		currency.trim().toUpperCase(),
	);
}

function productivelyGatedResearchScore(
	rawScore: number | null,
	indicator: IndicatorLike,
): number | null {
	const marginScore = marginPersistenceScore(indicator);
	const roicScore = statCurveScore(getNumberField(indicator, "roic"), "roic");
	if (rawScore == null || marginScore == null || roicScore == null) {
		return null;
	}
	if (marginScore < 4 || roicScore < 4) {
		return Math.min(rawScore, 4);
	}
	return rawScore;
}

function scalePersistenceScore(indicator: IndicatorLike): number | null {
	return weightedMeanScore([
		[scaleScore(getNumberField(indicator, "revenue"), "revenue"), 0.3],
		[
			scaleScore(getNumberField(indicator, "free_cash_flow"), "free_cash_flow"),
			0.25,
		],
		[
			statCurveScore(
				getNumberField(indicator, "revenue_cagr_3y"),
				"revenue_growth",
			),
			0.25,
		],
		[marginPersistenceScore(indicator), 0.2],
	]);
}

function capitalProductivityScore(indicator: IndicatorLike): number | null {
	const fcfMarginMedian = getNumberField(indicator, "fcf_margin_median_3y");
	const fcfMarginScore =
		fcfMarginMedian == null
			? null
			: mapToCurveScore(fcfMarginMedian, -5, 35, 15);
	const rawScore = weightedMeanScore([
		[fcfMarginScore, 0.4],
		[statCurveScore(getNumberField(indicator, "roic"), "roic"), 0.35],
		[marginPersistenceScore(indicator), 0.25],
	]);
	const marginScore = marginPersistenceScore(indicator);
	const roicScore = statCurveScore(getNumberField(indicator, "roic"), "roic");
	if (rawScore == null || marginScore == null || roicScore == null) {
		return rawScore;
	}
	return Math.min(rawScore, marginScore + 1, roicScore + 1);
}

function knowledgeCapitalScore(indicator: IndicatorLike): number | null {
	if (!usesComparableFinancialsCurrency(indicator)) {
		return null;
	}
	return productivelyGatedResearchScore(
		scaleScore(
			getNumberField(indicator, "rd_knowledge_capital"),
			"rd_knowledge_capital",
		),
		indicator,
	);
}

function rdProductivityScore(indicator: IndicatorLike): number | null {
	const rawScore = weightedMeanScore([
		[
			usesComparableFinancialsCurrency(indicator)
				? scaleScore(
						getNumberField(indicator, "rd_knowledge_capital"),
						"rd_knowledge_capital",
					)
				: null,
			0.65,
		],
		[
			statCurveScore(getNumberField(indicator, "rd_intensity"), "rd_intensity"),
			0.35,
		],
	]);
	return productivelyGatedResearchScore(rawScore, indicator);
}

function structuralMoatProxyScore(indicator: IndicatorLike): number | null {
	return weightedMeanScore([
		[
			knowledgeCapitalScore(indicator),
			MoatSignalMultipliers.RD_KNOWLEDGE_CAPITAL,
		],
		[rdProductivityScore(indicator), MoatSignalMultipliers.RD_PRODUCTIVITY],
		[
			marginPersistenceScore(indicator),
			MoatSignalMultipliers.MARGIN_PERSISTENCE,
		],
		[
			statCurveScore(getNumberField(indicator, "roic"), "roic"),
			MoatSignalMultipliers.ROIC_PERSISTENCE,
		],
		[scalePersistenceScore(indicator), MoatSignalMultipliers.SCALE_PERSISTENCE],
		[
			capitalProductivityScore(indicator),
			MoatSignalMultipliers.CAPITAL_PRODUCTIVITY,
		],
	]);
}

/** Compute market-derived moat from scale, durable margins, returns, and balance sheet. */
export function calculateMoatSignalScore(
	indicator: IndicatorLike,
): number | null {
	const economicScore = weightedMeanScore([
		[
			scaleScore(getNumberField(indicator, "revenue"), "revenue"),
			MoatSignalMultipliers.REVENUE_SCALE,
		],
		[
			scaleScore(getNumberField(indicator, "free_cash_flow"), "free_cash_flow"),
			MoatSignalMultipliers.FCF_SCALE,
		],
		[
			statCurveScore(getNumberField(indicator, "gross_margin"), "gross_margin"),
			MoatSignalMultipliers.GROSS_MARGIN,
		],
		[
			statCurveScore(
				getNumberField(indicator, "operating_margin"),
				"operating_margin",
			),
			MoatSignalMultipliers.OPERATING_MARGIN,
		],
		[
			statCurveScore(getNumberField(indicator, "roe"), "roe"),
			MoatSignalMultipliers.ROE,
		],
		[
			statCurveScore(getNumberField(indicator, "roic"), "roic"),
			MoatSignalMultipliers.ROIC,
		],
		[
			statCurveScore(
				isBankLike(indicator)
					? null
					: getNumberField(indicator, "debt_to_equity"),
				"debt_to_equity",
				true,
			),
			MoatSignalMultipliers.DEBT_TO_EQUITY,
		],
	]);
	const rawScore = weightedMeanScore([
		[economicScore, MoatBlendConfig.ECONOMIC_WEIGHT],
		[structuralMoatProxyScore(indicator), MoatBlendConfig.STRUCTURAL_WEIGHT],
	]);
	if (rawScore == null) {
		return null;
	}
	const risk = calculatePeakCycleRisk(indicator);
	if (risk >= CycleNormalizationConfig.HIGH_RISK) {
		return Math.min(rawScore, CycleNormalizationConfig.HIGH_RISK_MOAT_CAP);
	}
	if (
		!hasTrendHistory(indicator) &&
		risk >= CycleNormalizationConfig.NO_TREND_MOAT_CAP_RISK
	) {
		return Math.min(rawScore, CycleNormalizationConfig.NO_TREND_MOAT_CAP);
	}
	return rawScore;
}

/** Compute market-derived quality from scale, growth, margins, returns, and owner yield. */
export function calculateQualitySignalScore(
	indicator: IndicatorLike,
): number | null {
	const factors: Array<[number | null, number]> = [
		[
			scaleScore(getNumberField(indicator, "revenue"), "revenue"),
			QualitySignalMultipliers.REVENUE_SCALE,
		],
		[
			qualityGrowthScore(
				getNumberField(indicator, "revenue_growth"),
				"revenue_growth",
			),
			QualitySignalMultipliers.REVENUE_GROWTH,
		],
		[
			qualityGrowthScore(getNumberField(indicator, "eps_growth"), "eps_growth"),
			QualitySignalMultipliers.EPS_GROWTH,
		],
		[
			scaleScore(getNumberField(indicator, "free_cash_flow"), "free_cash_flow"),
			QualitySignalMultipliers.FCF_SCALE,
		],
		[
			statCurveScore(getNumberField(indicator, "gross_margin"), "gross_margin"),
			QualitySignalMultipliers.GROSS_MARGIN,
		],
		[
			statCurveScore(
				getNumberField(indicator, "operating_margin"),
				"operating_margin",
			),
			QualitySignalMultipliers.OPERATING_MARGIN,
		],
		[
			statCurveScore(getNumberField(indicator, "roe"), "roe"),
			QualitySignalMultipliers.ROE,
		],
		[
			statCurveScore(getNumberField(indicator, "roic"), "roic"),
			QualitySignalMultipliers.ROIC,
		],
		[
			statCurveScore(
				getNumberField(indicator, "shareholder_yield"),
				"shareholder_yield",
			),
			QualitySignalMultipliers.SHAREHOLDER_YIELD,
		],
	];
	const availableFactorCount = factors.filter(
		([score]) => score != null,
	).length;
	if (availableFactorCount < 2) {
		return null;
	}
	const fcfMarginMedian = getNumberField(indicator, "fcf_margin_median_3y");
	const sharesChange =
		getNumberField(indicator, "shares_change_cagr_3y") ??
		getNumberField(indicator, "shares_change_1y");
	const beta = getNumberField(indicator, "beta");
	const currentQualityScore = weightedMeanScore(factors);
	const rawScore = weightedMeanScore([
		[currentQualityScore, QualitySignalConfig.CURRENT_WEIGHT],
		[
			marginPersistenceScore(indicator),
			QualitySignalConfig.MARGIN_PERSISTENCE_WEIGHT,
		],
		[
			fcfMarginMedian == null
				? null
				: mapToCurveScore(fcfMarginMedian, -5, 35, 15),
			QualitySignalConfig.FCF_MARGIN_WEIGHT,
		],
		[
			sharesChange == null
				? null
				: mapToCurveScore(sharesChange, -5, 10, 0, {
						outMin: SCORE_SCALE,
						outMax: 0,
					}),
			QualitySignalConfig.SHARES_DISCIPLINE_WEIGHT,
		],
		[
			weightedMeanScore([
				[
					marginStabilityScore(
						getNumberField(indicator, "operating_margin_std_3y"),
					),
					0.65,
				],
				[
					beta == null
						? null
						: mapToCurveScore(beta, 0.6, 1.8, 1, {
								outMin: SCORE_SCALE,
								outMax: 0,
							}),
					0.35,
				],
			]),
			QualitySignalConfig.STABILITY_WEIGHT,
		],
	]);
	const floor = viableBusinessQualityFloor(indicator);
	if (rawScore == null) {
		return floor;
	}
	const adjustedScore = clampScore(
		rawScore - overheatRisk(indicator) * OverheatSignalConfig.QUALITY_PENALTY,
	);
	const cycleRisk = calculatePeakCycleRisk(indicator);
	const cycleFloor =
		cycleRisk >= QualitySignalConfig.CYCLE_FLOOR_RISK_MIN &&
		(currentQualityScore ?? 0) >=
			QualitySignalConfig.CYCLE_FLOOR_CURRENT_QUALITY_MIN &&
		(marginPersistenceScore(indicator) ?? 0) >=
			QualitySignalConfig.CYCLE_FLOOR_MARGIN_PERSISTENCE_MIN
			? QualitySignalConfig.CYCLE_FLOOR
			: null;
	return Math.max(
		applyHighCycleCap(
			adjustedScore,
			cycleRisk,
			CycleNormalizationConfig.HIGH_RISK_QUALITY_CAP,
		) ?? adjustedScore,
		floor ?? adjustedScore,
		cycleFloor ?? adjustedScore,
	);
}

/** Score growth-driven upside, capped by weak valuation and business support. */
export function calculateCombinedUpsideScore(
	indicator: IndicatorLike,
	analystTargetGap: number | null,
	ratings: Array<Record<string, unknown>> | null | undefined,
): number | null {
	const revenueGrowthScore = statCurveScore(
		getNumberField(indicator, "revenue_growth"),
		"revenue_growth",
	);
	const epsGrowthScore = statCurveScore(
		getNumberField(indicator, "eps_growth"),
		"eps_growth",
	);
	const analystTargetGapScore = statCurveScore(
		analystTargetGap,
		"median_upside",
	);
	const ratingScore = calculateRatingScore(ratings);

	const rawUpsideComponents: Array<[number | null, number]> = [
		[revenueGrowthScore, UpsideMultipliers.REVENUE_GROWTH],
		[epsGrowthScore, UpsideMultipliers.EPS_GROWTH],
		[analystTargetGapScore, UpsideMultipliers.MEDIAN_UPSIDE],
		[ratingScore, UpsideMultipliers.RATING],
	];
	const availableRawCount = rawUpsideComponents.filter(
		([score]) => score != null,
	).length;
	if (availableRawCount < MIN_UPSIDE_RAW_COMPONENTS) {
		return null;
	}

	const rawUpsideScore = weightedMeanScore(rawUpsideComponents);
	if (rawUpsideScore == null) {
		return null;
	}

	const valuationScore = calculateValuationScore(indicator);
	const qualityScore = calculateQualitySignalScore(indicator);
	const moatScore = calculateMoatSignalScore(indicator);
	let cappedUpsideScore = rawUpsideScore;

	if (analystTargetGap != null && analystTargetGap < 0) {
		cappedUpsideScore = Math.min(
			cappedUpsideScore,
			analystTargetGap <= UpsideSupportConfig.DEEP_NEGATIVE_TARGET_GAP
				? UpsideSupportConfig.DEEP_NEGATIVE_TARGET_GAP_CAP
				: UpsideSupportConfig.NEGATIVE_TARGET_GAP_CAP,
		);
	}
	if (valuationScore != null && valuationScore < 3) {
		cappedUpsideScore = Math.min(cappedUpsideScore, WEAK_SUPPORT_UPSIDE_CAP);
	}
	if (
		valuationScore != null &&
		valuationScore < UpsideSupportConfig.LOW_VALUATION_TRUST
	) {
		cappedUpsideScore = Math.min(
			cappedUpsideScore,
			UpsideSupportConfig.LOW_VALUATION_HIGH_UPSIDE_CAP,
		);
	}
	if (
		cappedUpsideScore < UpsideSupportConfig.MATURE_UPSIDE_MAX &&
		(getNumberField(indicator, "revenue_growth") ?? Number.NEGATIVE_INFINITY) <
			UpsideSupportConfig.MATURE_REVENUE_GROWTH_MAX &&
		(calculateTacticalScore(indicator, analystTargetGap) ??
			Number.POSITIVE_INFINITY) < UpsideSupportConfig.MATURE_TACTICAL_MAX
	) {
		cappedUpsideScore = Math.min(
			cappedUpsideScore,
			UpsideSupportConfig.MATURE_UPSIDE_CAP,
		);
	}
	if (
		(qualityScore != null && qualityScore < 3) ||
		(moatScore != null && moatScore < 3)
	) {
		cappedUpsideScore = Math.min(cappedUpsideScore, WEAK_SUPPORT_UPSIDE_CAP);
	}
	if (
		valuationScore != null &&
		valuationScore < 2 &&
		qualityScore != null &&
		qualityScore < 3
	) {
		cappedUpsideScore = Math.min(
			cappedUpsideScore,
			VERY_WEAK_SUPPORT_UPSIDE_CAP,
		);
	}
	cappedUpsideScore -=
		overheatRisk(indicator) * OverheatSignalConfig.UPSIDE_PENALTY;

	return applyHighCycleCap(
		clampScore(cappedUpsideScore),
		calculatePeakCycleRisk(indicator),
		CycleNormalizationConfig.HIGH_RISK_UPSIDE_CAP,
	);
}

/** Score the short-to-medium-term setup without affecting durable fundamentals. */
export function calculateTacticalScore(
	indicator: IndicatorLike,
	analystTargetGap: number | null,
): number | null {
	return weightedMeanScore([
		[
			tacticalMomentumScore(getNumberField(indicator, "change_percent_1y")),
			TacticalScoreMultipliers.PRICE_MOMENTUM_1Y,
		],
		[
			tacticalMomentumScore(getNumberField(indicator, "change_percent_6m")),
			TacticalScoreMultipliers.PRICE_MOMENTUM_6M,
		],
		[
			tacticalGrowthScore(
				getNumberField(indicator, "revenue_growth"),
				"revenue_growth",
			),
			TacticalScoreMultipliers.REVENUE_GROWTH,
		],
		[
			tacticalGrowthScore(
				getNumberField(indicator, "eps_growth"),
				"eps_growth",
			),
			TacticalScoreMultipliers.EPS_GROWTH,
		],
		[calculateValuationScore(indicator), TacticalScoreMultipliers.VALUATION],
		[
			statCurveScore(analystTargetGap, "median_upside"),
			TacticalScoreMultipliers.MEDIAN_UPSIDE,
		],
		[
			tacticalActivityScore(getNumberField(indicator, "rsi"), [30, 55, 85]),
			TacticalScoreMultipliers.RSI_ACTIVITY,
		],
		[
			tacticalActivityScore(getNumberField(indicator, "iv"), [20, 45, 90]),
			TacticalScoreMultipliers.IV_ACTIVITY,
		],
	]);
}

/** Map list of analyst ratings to 0-10 engine score. */
export function calculateRatingScore(
	ratings: Array<Record<string, unknown>> | null | undefined,
): number | null {
	if (!ratings || ratings.length === 0) {
		return null;
	}

	const ratingValues = ratings
		.map((ratingRow) => {
			const grade =
				ratingRow.to_grade ??
				ratingRow.toGrade ??
				ratingRow.ToGrade ??
				ratingRow.rating ??
				ratingRow.grade;
			return typeof grade === "string" ? parseRatingGrade(grade) : null;
		})
		.filter((value): value is number => value != null);

	if (ratingValues.length === 0) {
		return null;
	}

	const [rangeMin, rangeMedian, rangeMax] = CalibrationConfig.RATING_RANGE;
	return mapToCurveScore(
		ratingValues.reduce((sum, value) => sum + value, 0) / ratingValues.length,
		rangeMin,
		rangeMax,
		rangeMedian,
	);
}

function parseRatingGrade(text: string): number | null {
	const normalizedText = text.toLowerCase();
	const mapping: Record<string, number> = {
		"strong buy": 5,
		buy: 4.5,
		overweight: 4,
		outperform: 4,
		hold: 3.5,
		neutral: 3.5,
		underperform: 2.5,
		underweight: 2.5,
		sell: 1,
	};
	if (normalizedText.includes("strong") && normalizedText.includes("buy")) {
		return 5;
	}
	for (const [keyword, value] of Object.entries(mapping)) {
		if (normalizedText.includes(keyword)) {
			return value;
		}
	}
	return null;
}

/** Apply strategy weights to core scores to find suitable portfolio buckets. */
export function calculateStrategyIndices(
	scores: Record<string, number | null | undefined>,
): Record<string, number | null> {
	const indices: Record<string, number | null> = {};

	for (const [name, bucket] of Object.entries(STRATEGY_BUCKETS)) {
		const bucketScores = bucket.scoreKeys.map((key) => scores[key] ?? null);
		if (bucketScores.some((score) => score == null)) {
			indices[name] = null;
			continue;
		}

		const adjustedScores = bucketScores.map((score, index) =>
			bucket.invertFlags[index] ? SCORE_SCALE - Number(score) : Number(score),
		);
		const weightedScore = adjustedScores.reduce(
			(sum, score, index) => sum + score * bucket.weights[index],
			0,
		);
		indices[name] = weightedScore;
	}
	return indices;
}
