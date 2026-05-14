/** Score durable business fundamentals from market and financial indicators. */

import {
	CycleNormalizationConfig,
	MoatBlendConfig,
	MoatSignalMultipliers,
	OverheatSignalConfig,
	QualitySignalConfig,
	QualitySignalMultipliers,
	SCORE_SCALE,
} from "../constants.js";
import { clampScore, mapToCurveScore } from "../math-utils.js";
import {
	applyHighCycleCap,
	calculatePeakCycleRisk,
	hasTrendHistory,
	overheatRisk,
} from "./cycle.js";
import {
	canonicalMarketCap,
	getNumberField,
	type IndicatorLike,
	isBankLike,
	qualityGrowthScore,
	scaleScore,
	statCurveScore,
	weightedMeanScore,
} from "./shared.js";

export function fcfYieldPercent(indicator: IndicatorLike): number | null {
	const marketCap = canonicalMarketCap(indicator);
	const freeCashFlow = getNumberField(indicator, "free_cash_flow");
	if (freeCashFlow == null || marketCap == null || marketCap <= 0) {
		return null;
	}
	return (freeCashFlow / marketCap) * 100;
}

export function marginStabilityScore(value: number | null): number | null {
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

export function durableGrowthScore(indicator: IndicatorLike): number | null {
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

export function marginPersistenceScore(
	indicator: IndicatorLike,
): number | null {
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
