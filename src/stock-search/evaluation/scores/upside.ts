/** Score growth-driven upside with quality, valuation, and cycle support caps. */

import {
	CalibrationConfig,
	CycleNormalizationConfig,
	OverheatSignalConfig,
	UpsideMultipliers,
	UpsideSupportConfig,
} from "../constants.js";
import { clampScore, mapToCurveScore } from "../math-utils.js";
import {
	applyHighCycleCap,
	calculatePeakCycleRisk,
	overheatRisk,
} from "./cycle.js";
import {
	calculateMoatSignalScore,
	calculateQualitySignalScore,
} from "./fundamentals.js";
import {
	getNumberField,
	type IndicatorLike,
	statCurveScore,
	weightedMeanScore,
} from "./shared.js";
import { calculateTacticalScore } from "./tactical.js";
import { calculateValuationScore } from "./valuation.js";

const MIN_UPSIDE_RAW_COMPONENTS = 2;
const WEAK_SUPPORT_UPSIDE_CAP = 6;
const VERY_WEAK_SUPPORT_UPSIDE_CAP = 4;

function calculateRatingScore(
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
