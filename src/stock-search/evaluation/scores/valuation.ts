/** Score valuation using public multiples, cash-flow support, and warranted FPE. */

import { getValuationScoreAnchors } from "../anchors.js";
import {
	CycleNormalizationConfig,
	CycleValuationGuardConfig,
	DEFAULT_SCORE,
	FcfYieldBlendConfig,
	QualityBackedValuationFloorConfig,
	ValuationMultipliers,
	WarrantedFpeConfig,
} from "../constants.js";
import { clampScore } from "../math-utils.js";
import {
	applyHighCycleCap,
	calculatePeakCycleRisk,
	overheatRisk,
	pullScoreTowardNeutral,
} from "./cycle.js";
import {
	calculateMoatSignalScore,
	calculateQualitySignalScore,
	durableGrowthScore,
	fcfYieldPercent,
} from "./fundamentals.js";
import {
	anchorRange,
	canonicalMarketCap,
	getNumberField,
	type IndicatorLike,
	isBankLike,
	marketCapScore,
	NORMALIZED_SCORE_RANGE,
	type ScoreAnchors,
	scaleScore,
	scoreOrNeutral,
	valuationEpsGrowthScore,
	valuationMultipleField,
	weightedMeanScore,
	weightedMeanStatScore,
} from "./shared.js";
import { tacticalSetupWithoutValuationScore } from "./tactical-signals.js";

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

function calculateLegacyValuationScore(
	indicator: IndicatorLike,
): number | null {
	const valuationAnchors = getValuationScoreAnchors(indicator);
	const pegRange = anchorRange("peg", valuationAnchors);
	const peRange = anchorRange("pe", valuationAnchors);
	const forwardPeRange = anchorRange("pe_forward", valuationAnchors);
	const debtToEquityRange = anchorRange("debt_to_equity", valuationAnchors);
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
