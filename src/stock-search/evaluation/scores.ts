/** Compute normalized factor scores from stock indicators. */

import type { FutureOutlook } from "../models/schemas.js";
import { asNumber } from "../utils.js";
import {
	CalibrationConfig,
	CoreEngineWeights,
	DiversifierWeights,
	EDGE_BASE,
	EDGE_MULTIPLIER,
	GameTierThresholds,
	MarketCapConfig,
	QualitySignalMultipliers,
	SatelliteWeights,
	SCORE_SCALE,
	SpeculativeWeights,
	type StrategyBucket,
	ThresholdConfig,
	ValuationMultipliers,
} from "./constants.js";
import { clampScore, mapToCurveScore } from "./math-utils.js";

type WeightedFactorConfig = [
	number | null,
	[number, number, number],
	number,
	boolean,
];
type IndicatorLike = Record<string, unknown>;

const MOMENTUM_INPUTS = [
	"change_percent_1d",
	"change_percent_1m",
	"change_percent_3m",
	"change_percent_6m",
	"change_percent_1y",
] as const;

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
		edgeWeight: CoreEngineWeights.EDGE,
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
		edgeWeight: SatelliteWeights.EDGE,
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
		edgeWeight: 0,
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
		edgeWeight: 0,
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

function fcfYieldPercent(indicator: IndicatorLike): number | null {
	const marketCap = canonicalMarketCap(indicator);
	const freeCashFlow = getNumberField(indicator, "free_cash_flow");
	if (freeCashFlow == null || marketCap == null || marketCap <= 0) {
		return null;
	}
	return (freeCashFlow / marketCap) * 100;
}

function viableBusinessQualityFloor(indicator: IndicatorLike): number | null {
	const revenueGrowth = getNumberField(indicator, "revenue_growth");
	const operatingMargin = getNumberField(indicator, "operating_margin");
	const roic = getNumberField(indicator, "roic");
	const grossMargin = getNumberField(indicator, "gross_margin");
	const freeCashFlowYield = fcfYieldPercent(indicator);

	const positiveSignals = [
		revenueGrowth != null && revenueGrowth > 0,
		operatingMargin != null && operatingMargin > 0,
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

function viableBusinessValuationFloor(indicator: IndicatorLike): number | null {
	const forwardPe = getNumberField(indicator, "pe_forward");
	const debtToEquity = getNumberField(indicator, "debt_to_equity");
	const freeCashFlowYield = fcfYieldPercent(indicator);

	if (
		forwardPe != null &&
		forwardPe > 0 &&
		forwardPe <= CalibrationConfig.FORWARD_PE_RANGE[2] &&
		(debtToEquity == null ||
			debtToEquity <= CalibrationConfig.DEBT_TO_EQUITY_PCT_RANGE[1]) &&
		freeCashFlowYield != null &&
		freeCashFlowYield > 0
	) {
		return 2;
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
		Math.log10(MarketCapConfig.MIN),
		Math.log10(MarketCapConfig.MAX),
		Math.log10(MarketCapConfig.MEDIAN),
	);
}

/** Compute weighted valuation score from valuation and balance-sheet metrics. */
export function calculateValuationScore(
	indicator: IndicatorLike,
): number | null {
	const rawScore = weightedMeanStatScore([
		[
			valuationMultipleField(indicator, "peg", CalibrationConfig.PEG_RANGE),
			CalibrationConfig.PEG_RANGE,
			ValuationMultipliers.PEG,
			true,
		],
		[
			valuationMultipleField(
				indicator,
				"pe",
				CalibrationConfig.TRAILING_PE_RANGE,
			),
			CalibrationConfig.TRAILING_PE_RANGE,
			ValuationMultipliers.PE,
			true,
		],
		[
			valuationMultipleField(
				indicator,
				"pe_forward",
				CalibrationConfig.FORWARD_PE_RANGE,
			),
			CalibrationConfig.FORWARD_PE_RANGE,
			ValuationMultipliers.PE_FORWARD,
			true,
		],
		[
			getNumberField(indicator, "debt_to_equity"),
			CalibrationConfig.DEBT_TO_EQUITY_PCT_RANGE,
			ValuationMultipliers.DEBT_TO_EQUITY,
			true,
		],
		[
			fcfYieldPercent(indicator),
			CalibrationConfig.FCF_YIELD_PCT_RANGE,
			ValuationMultipliers.FCF_YIELD,
			false,
		],
		[
			getNumberField(indicator, "shareholder_yield"),
			CalibrationConfig.SHAREHOLDER_YIELD_PCT_RANGE,
			ValuationMultipliers.SHAREHOLDER_YIELD,
			false,
		],
		[
			getNumberField(indicator, "operating_margin"),
			CalibrationConfig.OPERATING_MARGIN_PCT_RANGE,
			ValuationMultipliers.OPERATING_MARGIN,
			false,
		],
		[
			getNumberField(indicator, "roic"),
			CalibrationConfig.ROIC_PCT_RANGE,
			ValuationMultipliers.ROIC,
			false,
		],
	]);
	const floor = viableBusinessValuationFloor(indicator);
	return rawScore == null ? floor : Math.max(rawScore, floor ?? rawScore);
}

/** Compute market-derived quality score from growth and margin. */
export function calculateQualitySignalScore(
	indicator: IndicatorLike,
): number | null {
	const factors: WeightedFactorConfig[] = [
		[
			getNumberField(indicator, "revenue_growth"),
			CalibrationConfig.REVENUE_GROWTH_PCT_RANGE,
			QualitySignalMultipliers.REVENUE_GROWTH,
			false,
		],
		[
			getNumberField(indicator, "gross_margin"),
			CalibrationConfig.GROSS_MARGIN_PCT_RANGE,
			QualitySignalMultipliers.GROSS_MARGIN,
			false,
		],
		[
			getNumberField(indicator, "operating_margin"),
			CalibrationConfig.OPERATING_MARGIN_PCT_RANGE,
			QualitySignalMultipliers.OPERATING_MARGIN,
			false,
		],
		[
			getNumberField(indicator, "roic"),
			CalibrationConfig.ROIC_PCT_RANGE,
			QualitySignalMultipliers.ROIC,
			false,
		],
		[
			getNumberField(indicator, "shareholder_yield"),
			CalibrationConfig.SHAREHOLDER_YIELD_PCT_RANGE,
			QualitySignalMultipliers.SHAREHOLDER_YIELD,
			false,
		],
	];
	const availableFactorCount = factors.filter(
		([value]) => value != null,
	).length;
	if (availableFactorCount < 2) {
		return null;
	}
	const rawScore = weightedMeanStatScore(factors);
	const floor = viableBusinessQualityFloor(indicator);
	return rawScore == null ? floor : Math.max(rawScore, floor ?? rawScore);
}

/** Blend analyst upside, current ratings, and LLM outlook into a single score. */
export function calculateCombinedUpsideScore(
	medianUpside: number | null,
	ratings: Array<Record<string, unknown>> | null | undefined,
	outlookScore: number | null,
): number | null {
	const [rangeMin, rangeMedian, rangeMax] = CalibrationConfig.UPSIDE_RANGE;
	const analystUpsideScore =
		medianUpside == null
			? null
			: mapToCurveScore(medianUpside, rangeMin, rangeMax, rangeMedian);
	const ratingScore = calculateRatingScore(ratings);
	const availableScores = [
		analystUpsideScore,
		ratingScore,
		outlookScore,
	].filter((value): value is number => value != null);
	return availableScores.length > 0
		? clampScore(
				availableScores.reduce((sum, value) => sum + value, 0) /
					availableScores.length,
			)
		: null;
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

function probabilityToScore(value: number | null): number | null {
	if (value == null) {
		return null;
	}
	const [rangeMin, rangeMedian, rangeMax] = CalibrationConfig.PROBABILITY_RANGE;
	return mapToCurveScore(value, rangeMin, rangeMax, rangeMedian);
}

/** Derive calibrated bull/bear scores from LLM and/or historical momentum. */
export function modelProbabilities(
	indicator: IndicatorLike,
	outlook: FutureOutlook | null | undefined,
): [number | null, number | null] {
	const [bullMomentumScore, bearMomentumScore] =
		calculateHistoricalMomentumScores(indicator);
	const bullMomentumProbability = probabilityToScore(
		bullMomentumScore == null ? null : bullMomentumScore / SCORE_SCALE,
	);
	const bearMomentumProbability = probabilityToScore(
		bearMomentumScore == null ? null : bearMomentumScore / SCORE_SCALE,
	);

	let bullLlmProbability: number | null = null;
	let bearLlmProbability: number | null = null;
	if (outlook?.bull_probability != null && outlook.bear_probability != null) {
		bullLlmProbability = probabilityToScore(outlook.bull_probability);
		bearLlmProbability = probabilityToScore(outlook.bear_probability);
	}

	if (bullLlmProbability == null || bearLlmProbability == null) {
		return [bullMomentumProbability, bearMomentumProbability];
	}
	if (bullMomentumProbability == null || bearMomentumProbability == null) {
		return [bullLlmProbability, bearLlmProbability];
	}
	return [
		(bullLlmProbability + bullMomentumProbability) / 2,
		(bearLlmProbability + bearMomentumProbability) / 2,
	];
}

/** Average recent price changes into a 0-10 momentum score. */
export function calculateHistoricalMomentumScores(
	indicator: IndicatorLike,
): [number | null, number | null] {
	const validChanges = MOMENTUM_INPUTS.map((fieldName) =>
		getNumberField(indicator, fieldName),
	).filter((value): value is number => value != null);

	if (validChanges.length === 0) {
		return [null, null];
	}

	const averageChange =
		validChanges.reduce((sum, value) => sum + value, 0) / validChanges.length;
	return [
		clampScore(
			ThresholdConfig.DIRECTION_BASE_SCORE +
				averageChange / ThresholdConfig.DIRECTION_CHANGE_DIVISOR,
		),
		clampScore(
			ThresholdConfig.DIRECTION_BASE_SCORE -
				averageChange / ThresholdConfig.DIRECTION_CHANGE_DIVISOR,
		),
	];
}

/** Apply strategy weights to core scores to find suitable portfolio buckets. */
export function calculateStrategyIndices(
	scores: Record<string, number | null | undefined>,
	edge: number | null,
): Record<string, number | null> {
	const edgeComponent =
		edge == null ? null : EDGE_BASE + EDGE_MULTIPLIER * edge;
	const indices: Record<string, number | null> = {};

	for (const [name, bucket] of Object.entries(STRATEGY_BUCKETS)) {
		const bucketScores = bucket.scoreKeys.map((key) => scores[key] ?? null);
		if (
			bucketScores.some((score) => score == null) ||
			(bucket.edgeWeight !== 0 && edgeComponent == null)
		) {
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
		indices[name] = weightedScore + bucket.edgeWeight * (edgeComponent ?? 0);
	}
	return indices;
}

/** Return true if an asset looks like a 'chase' opportunity. */
export function checkFomoConditions(
	scores: Record<string, number | null | undefined>,
	bullScore: number | null,
): boolean {
	const valuationScore = scores.valuation_score;
	const upsideScore = scores.upside_score;
	if (valuationScore == null || upsideScore == null || bullScore == null) {
		return false;
	}
	return (
		valuationScore <= ThresholdConfig.FOMO_VALUATION &&
		upsideScore >= ThresholdConfig.FOMO_UPSIDE &&
		bullScore <= ThresholdConfig.FOMO_BULL
	);
}

/** Calculate Elo delta based on success probability. */
export function calculateEloDelta(probability: number | null): number | null {
	if (probability == null || !(probability > 0 && probability < 1)) {
		return null;
	}
	return 400 * Math.log10(probability / (1 - probability));
}

/** Categorize the 'edge' level of the setup. */
export function getGameTier(bullScore: number | null): string {
	if (bullScore == null) {
		return "normal";
	}
	if (bullScore >= GameTierThresholds.RARE_DISLOCATION) {
		return "rare dislocation-level";
	}
	if (
		bullScore >= GameTierThresholds.SMURFING_MIN &&
		bullScore <= GameTierThresholds.SMURFING_MAX
	) {
		return "smurfing";
	}
	if (
		bullScore >= GameTierThresholds.VERY_HIGH_MIN &&
		bullScore <= GameTierThresholds.VERY_HIGH_MAX
	) {
		return "very high";
	}
	if (
		bullScore >= GameTierThresholds.HIGH_EDGE_MIN &&
		bullScore <= GameTierThresholds.HIGH_EDGE_MAX
	) {
		return "already high edge";
	}
	return "normal";
}
