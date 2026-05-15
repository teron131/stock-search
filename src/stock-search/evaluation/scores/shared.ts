/** Shared score-engine primitives for indicator extraction and weighted blends. */

import { asNumber } from "../../utils.js";
import {
	getScoreAnchors,
	type ScoreAnchorKey,
	type ScoreAnchors,
} from "../anchors.js";
import {
	DEFAULT_SCORE,
	QualitySignalConfig,
	SCORE_SCALE,
	ValuationSignalConfig,
} from "../constants.js";
import { clampScore, mapToCurveScore } from "../math-utils.js";

export type { ScoreAnchorKey, ScoreAnchors };

export type WeightedFactorConfig = [
	number | null,
	[number, number, number],
	number,
	boolean,
];
export type IndicatorLike = Record<string, unknown>;

export const NORMALIZED_SCORE_RANGE: [number, number, number] = [
	0,
	SCORE_SCALE / 2,
	SCORE_SCALE,
];

export function getNumberField(
	indicator: IndicatorLike,
	fieldName: string,
): number | null {
	return asNumber(indicator[fieldName]);
}

export function canonicalMarketCap(indicator: IndicatorLike): number | null {
	return getNumberField(indicator, "market_cap");
}

export function valuationMultipleField(
	indicator: IndicatorLike,
	fieldName: string,
	[, , weakAnchor]: [number, number, number],
): number | null {
	const value = getNumberField(indicator, fieldName);
	return value == null ? null : value <= 0 ? weakAnchor : value;
}

export function anchorRange(
	anchorKey: ScoreAnchorKey,
	anchors: ScoreAnchors = getScoreAnchors(),
): [number, number, number] {
	return anchors[anchorKey];
}

export function statCurveScore(
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

export function qualityGrowthScore(
	value: number | null,
	anchorKey: "revenue_growth" | "eps_growth",
): number | null {
	const score = statCurveScore(value, anchorKey);
	return score == null
		? null
		: Math.min(score, QualitySignalConfig.MAX_SINGLE_YEAR_GROWTH_SCORE);
}

export function valuationEpsGrowthScore(value: number | null): number | null {
	const score = statCurveScore(value, "eps_growth");
	return score == null
		? null
		: Math.min(score, ValuationSignalConfig.MAX_SINGLE_YEAR_EPS_GROWTH_SCORE);
}

export function weightedMeanUnit(
	factors: Array<[number | null, number]>,
): number {
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

export function weightedMeanStatScore(
	factors: WeightedFactorConfig[],
): number | null {
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

export function weightedMeanScore(
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

export function finiteScore(value: number | null | undefined): number | null {
	return value == null || !Number.isFinite(value) ? null : value;
}

export function scoreOrNeutral(value: number | null | undefined): number {
	return finiteScore(value) ?? DEFAULT_SCORE;
}

export function isBankLike(indicator: IndicatorLike): boolean {
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

export function scaleScore(
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

/** Map market cap to 1-10 using a Log-S-curve. */
export function marketCapScore(
	info: Record<string, unknown> | null | undefined = null,
): number | null {
	if (!info) {
		return null;
	}
	const marketCap =
		"marketCap" in info ? asNumber(info.marketCap) : canonicalMarketCap(info);
	const quoteType = String(info.quoteType ?? info.quote_type ?? "")
		.trim()
		.toUpperCase();
	const hasProxiedMarketCap =
		Array.isArray(info.proxied_stat_fields) &&
		info.proxied_stat_fields.some((field) => String(field) === "market_cap");
	const isFund = quoteType === "ETF" || quoteType === "MUTUALFUND";
	if ((isFund && !hasProxiedMarketCap) || marketCap == null || marketCap <= 0) {
		return null;
	}

	return mapToCurveScore(
		Math.log10(marketCap),
		Math.log10(anchorRange("market_cap")[0]),
		Math.log10(anchorRange("market_cap")[2]),
		Math.log10(anchorRange("market_cap")[1]),
		{ outMin: 0, outMax: SCORE_SCALE },
	);
}
