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
	DiversifierWeights,
	MoatSignalMultipliers,
	QualitySignalMultipliers,
	SatelliteWeights,
	SCORE_SCALE,
	SpeculativeWeights,
	type StrategyBucket,
	UpsideMultipliers,
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

/** Compute weighted valuation score from valuation and balance-sheet metrics. */
export function calculateValuationScore(
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
	const epsGrowthRange = anchorRange("eps_growth", valuationAnchors);
	const operatingMarginRange = anchorRange(
		"operating_margin",
		valuationAnchors,
	);
	const roicRange = anchorRange("roic", valuationAnchors);

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
			getNumberField(indicator, "debt_to_equity"),
			debtToEquityRange,
			ValuationMultipliers.DEBT_TO_EQUITY,
			true,
		],
		[
			fcfYieldPercent(indicator),
			fcfYieldRange,
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
			getNumberField(indicator, "eps_growth"),
			epsGrowthRange,
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
	return rawScore == null ? floor : Math.max(rawScore, floor ?? rawScore);
}

/** Compute market-derived moat from scale, durable margins, returns, and balance sheet. */
export function calculateMoatSignalScore(
	indicator: IndicatorLike,
): number | null {
	return weightedMeanScore([
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
				getNumberField(indicator, "debt_to_equity"),
				"debt_to_equity",
				true,
			),
			MoatSignalMultipliers.DEBT_TO_EQUITY,
		],
	]);
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
			statCurveScore(
				getNumberField(indicator, "revenue_growth"),
				"revenue_growth",
			),
			QualitySignalMultipliers.REVENUE_GROWTH,
		],
		[
			statCurveScore(getNumberField(indicator, "eps_growth"), "eps_growth"),
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
	const rawScore = weightedMeanScore(factors);
	const floor = viableBusinessQualityFloor(indicator);
	return rawScore == null ? floor : Math.max(rawScore, floor ?? rawScore);
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

	if (valuationScore != null && valuationScore < 3) {
		cappedUpsideScore = Math.min(cappedUpsideScore, WEAK_SUPPORT_UPSIDE_CAP);
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

	return clampScore(cappedUpsideScore);
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
