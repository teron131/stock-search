/** Compute normalized factor scores from stock indicators. */

import {
	EDGE_BASE,
	EDGE_MULTIPLIER,
	SCORE_SCALE,
	CalibrationConfig,
	CoreEngineWeights,
	DiversifierWeights,
	GameTierThresholds,
	MarketCapConfig,
	QualitySignalWeights,
	SatelliteWeights,
	SpeculativeWeights,
	type StrategyBucket,
	ThresholdConfig,
	ValuationWeights,
} from "./constants.js";
import { clampScore, zScoreMap } from "./math-utils.js";
import type { FutureOutlook } from "../models/schemas.js";
import { asRecord, asNumber } from "../utils.js";

type WeightedFactorConfig = [number | null, [number, number, number], number, boolean];
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
		scoreKeys: ["moat_score", "quality_score", "valuation_score", "upside_score"],
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
		scoreKeys: ["upside_score", "quality_score", "moat_score", "valuation_score"],
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
		scoreKeys: ["quality_score", "valuation_score", "size_score", "upside_score"],
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

function getNumberField(indicator: IndicatorLike, fieldName: string): number | null {
	return asNumber(indicator[fieldName]);
}

function weightedZscoreAverage(factors: WeightedFactorConfig[]): number | null {
	const weightedScores: number[] = [];
	let totalWeight = 0;

	for (const [value, inputRange, weight, inverse] of factors) {
		if (value == null) {
			continue;
		}
		const [rangeMin, rangeMedian, rangeMax] = inputRange;
		const score = zScoreMap(
			value,
			rangeMin,
			rangeMax,
			rangeMedian,
			inverse ? 10 : 0,
			inverse ? 0 : 10,
		);
		weightedScores.push(score * weight);
		totalWeight += weight;
	}

	if (totalWeight === 0) {
		return null;
	}
	return clampScore(weightedScores.reduce((sum, value) => sum + value, 0) / totalWeight);
}

function fcfYieldPercent(indicator: IndicatorLike): number | null {
	const marketCap = getNumberField(indicator, "market_cap");
	const freeCashFlow = getNumberField(indicator, "free_cash_flow");
	if (freeCashFlow == null || marketCap == null || marketCap <= 0) {
		return null;
	}
	return (freeCashFlow / marketCap) * 100;
}

/** Map market cap to 1-10 using a Log-S-curve. */
export function marketCapScore(
	info: Record<string, unknown> | null | undefined = null,
): number | null {
	if (!info) {
		return null;
	}
	const marketCap = asNumber(info.marketCap ?? info.market_cap);
	const quoteType = info.quoteType ?? info.quote_type;
	if (quoteType === "ETF" || marketCap == null || marketCap <= 0) {
		return null;
	}

	return zScoreMap(
		Math.log10(marketCap),
		Math.log10(MarketCapConfig.MIN),
		Math.log10(MarketCapConfig.MAX),
		Math.log10(MarketCapConfig.MEDIAN),
	);
}

/** Compute weighted valuation score from valuation and balance-sheet metrics. */
export function calculateValuationScore(indicator: IndicatorLike): number | null {
	return weightedZscoreAverage([
		[
			getNumberField(indicator, "peg"),
			CalibrationConfig.PEG_RANGE,
			ValuationWeights.PEG,
			true,
		],
		[
			getNumberField(indicator, "pe"),
			CalibrationConfig.TRAILING_PE_RANGE,
			ValuationWeights.PE,
			true,
		],
		[
			getNumberField(indicator, "pe_forward"),
			CalibrationConfig.FORWARD_PE_RANGE,
			ValuationWeights.PE_FORWARD,
			true,
		],
		[
			getNumberField(indicator, "debt_to_equity"),
			CalibrationConfig.DEBT_TO_EQUITY_PCT_RANGE,
			ValuationWeights.DEBT_TO_EQUITY,
			true,
		],
		[
			fcfYieldPercent(indicator),
			CalibrationConfig.FCF_YIELD_PCT_RANGE,
			ValuationWeights.FCF_YIELD,
			false,
		],
	]);
}

/** Compute market-derived quality score from growth and margin. */
export function calculateQualitySignalScore(indicator: IndicatorLike): number | null {
	return weightedZscoreAverage([
		[
			getNumberField(indicator, "revenue_growth"),
			CalibrationConfig.REVENUE_GROWTH_PCT_RANGE,
			QualitySignalWeights.REVENUE_GROWTH,
			false,
		],
		[
			getNumberField(indicator, "gross_margin"),
			CalibrationConfig.GROSS_MARGIN_PCT_RANGE,
			QualitySignalWeights.GROSS_MARGIN,
			false,
		],
	]);
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
			: zScoreMap(medianUpside, rangeMin, rangeMax, rangeMedian);
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
				ratingRow.toGrade ?? ratingRow.rating ?? ratingRow.grade;
			return typeof grade === "string" ? parseRatingGrade(grade) : null;
		})
		.filter((value): value is number => value != null);

	if (ratingValues.length === 0) {
		return null;
	}

	const [rangeMin, rangeMedian, rangeMax] = CalibrationConfig.RATING_RANGE;
	return zScoreMap(
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
	return zScoreMap(value, rangeMin, rangeMax, rangeMedian);
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
