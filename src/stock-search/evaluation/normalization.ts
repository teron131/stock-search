/** Normalize evaluation payloads into the dashboard schema. */

import type { Evaluation, ScoredReason } from "../models/schemas.js";
import { StrategyGateConfig } from "./constants.js";
import {
	calculateCombinedUpsideScore,
	calculateMoatSignalScore,
	calculateOverallScore,
	calculatePeakCycleRisk,
	calculateQualitySignalScore,
	calculateTacticalScore,
	calculateValuationScore,
	marketCapScore,
} from "./scores.js";

const DEFAULT_BUCKET = "Speculation";
const SCORE_DIGITS = 2;

function roundScore(value: number | null): number | null {
	return value == null || !Number.isFinite(value)
		? null
		: Number(value.toFixed(SCORE_DIGITS));
}

function scoreFromEvaluationField(value: unknown): number | null {
	if (value == null) {
		return null;
	}
	if (typeof value === "object" && value !== null && "score" in value) {
		return scoreFromEvaluationField((value as { score?: unknown }).score);
	}
	if (typeof value === "string" && value.trim() === "") {
		return null;
	}
	const converted = Number(value);
	return Number.isFinite(converted) ? converted : null;
}

function optionalScore(value: unknown): number | null {
	return roundScore(scoreFromEvaluationField(value));
}

function setScoreIfPresent(
	target: Record<string, number>,
	key: string,
	value: unknown,
): void {
	const score = optionalScore(value);
	if (score != null) {
		target[key] = score;
	}
}

/** Normalize an evaluation entry to canonical keys used by the app. */
export function normalizeEvaluation(
	data: Record<string, unknown> | null | undefined,
): Record<string, number> {
	if (!data || Object.keys(data).length === 0) {
		return {};
	}

	const normalized: Record<string, number> = {};
	for (const key of [
		"overall_score",
		"moat_score",
		"quality_score",
		"valuation_score",
		"upside_score",
		"market_cap_score",
		"tactical_score",
		"llm_quality_score",
	]) {
		setScoreIfPresent(normalized, key, data[key]);
	}
	return normalized;
}

function setDerivedScore(
	target: Record<string, number>,
	key: string,
	value: number | null,
): void {
	const score = roundScore(value);
	if (score != null) {
		target[key] = score;
		return;
	}
	delete target[key];
}

function setOptionalStoredScore(
	target: Record<string, number>,
	key: string,
	value: unknown,
): void {
	const score = optionalScore(value);
	if (score != null) {
		target[key] = score;
		return;
	}
	delete target[key];
}

function analystTargetGap(
	indicatorRow: Record<string, unknown>,
): number | null {
	const value = indicatorRow.median_upside;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function analystRatings(
	indicatorRow: Record<string, unknown>,
): Array<Record<string, unknown>> | null {
	return Array.isArray(indicatorRow.ratings)
		? (indicatorRow.ratings as Array<Record<string, unknown>>)
		: null;
}

function currentEvaluationScores(
	indicatorRow: Record<string, unknown>,
): Record<string, number> {
	const normalized: Record<string, number> = {};
	const quoteType = String(
		indicatorRow.quote_type ?? indicatorRow.equity_type ?? "",
	)
		.trim()
		.toUpperCase();
	const hasProxyStats =
		Array.isArray(indicatorRow.proxied_stat_fields) &&
		indicatorRow.proxied_stat_fields.length > 0;
	if ((quoteType === "ETF" || quoteType === "MUTUALFUND") && !hasProxyStats) {
		return normalized;
	}

	setDerivedScore(
		normalized,
		"quality_score",
		calculateQualitySignalScore(indicatorRow),
	);
	setDerivedScore(
		normalized,
		"moat_score",
		calculateMoatSignalScore(indicatorRow),
	);
	setDerivedScore(
		normalized,
		"valuation_score",
		calculateValuationScore(indicatorRow),
	);
	setDerivedScore(
		normalized,
		"upside_score",
		calculateCombinedUpsideScore(
			indicatorRow,
			analystTargetGap(indicatorRow),
			analystRatings(indicatorRow),
		),
	);
	setDerivedScore(normalized, "market_cap_score", marketCapScore(indicatorRow));
	setDerivedScore(
		normalized,
		"tactical_score",
		calculateTacticalScore(indicatorRow, analystTargetGap(indicatorRow)),
	);
	setDerivedScore(
		normalized,
		"overall_score",
		calculateOverallScore(normalized, calculatePeakCycleRisk(indicatorRow)),
	);
	return normalized;
}

/** Derive current deterministic evaluation scores from indicator stats. */
export function deriveEvaluationScores(
	data: Record<string, unknown> | null | undefined,
	indicators: Record<string, unknown> | null | undefined,
): Record<string, number> {
	const normalized = normalizeEvaluation(data);
	const indicatorRow = indicators ?? {};
	const derivedScores = currentEvaluationScores(indicatorRow);

	for (const key of [
		"quality_score",
		"valuation_score",
		"moat_score",
		"upside_score",
		"market_cap_score",
		"tactical_score",
		"overall_score",
	]) {
		setOptionalStoredScore(normalized, key, derivedScores[key]);
	}
	setOptionalStoredScore(
		normalized,
		"llm_quality_score",
		data?.llm_quality_score,
	);

	return normalized;
}

/** Build an `Evaluation` model from an evaluation entry. */
export function evaluationFromRecord(
	data: Record<string, unknown> | null | undefined,
): Evaluation | null {
	const normalized = normalizeEvaluation(data);
	if (Object.keys(normalized).length === 0) {
		return null;
	}

	const emptyReasons: ScoredReason["reasons"] = [];
	return {
		score: normalized.overall_score,
		reasons: emptyReasons,
		market_cap_score: normalized.market_cap_score,
		valuation_score: normalized.valuation_score,
		upside_score: normalized.upside_score,
		moat_score: {
			score: normalized.moat_score,
			reasons: emptyReasons,
		},
		quality_score: {
			score: normalized.quality_score,
			reasons: emptyReasons,
		},
	};
}

function scoreAtLeast(
	value: number | null | undefined,
	minimum: number,
): boolean {
	return value != null && Number.isFinite(value) && value >= minimum;
}

function scoreAtMost(
	value: number | null | undefined,
	maximum: number,
): boolean {
	return value != null && Number.isFinite(value) && value <= maximum;
}

function passesCoreGate(scores: Record<string, number | undefined>): boolean {
	return (
		scoreAtLeast(scores.overall_score, StrategyGateConfig.CORE_OVERALL_MIN) &&
		scoreAtLeast(scores.moat_score, StrategyGateConfig.CORE_MOAT_MIN) &&
		scoreAtLeast(scores.quality_score, StrategyGateConfig.CORE_QUALITY_MIN) &&
		scoreAtLeast(scores.valuation_score, StrategyGateConfig.CORE_VALUATION_MIN)
	);
}

function passesSatelliteGate(
	scores: Record<string, number | undefined>,
): boolean {
	return (
		scoreAtLeast(
			scores.overall_score,
			StrategyGateConfig.SATELLITE_OVERALL_MIN,
		) &&
		scoreAtLeast(
			scores.valuation_score,
			StrategyGateConfig.SATELLITE_VALUATION_MIN,
		) &&
		scoreAtLeast(scores.moat_score, StrategyGateConfig.SATELLITE_MOAT_MIN) &&
		scoreAtLeast(
			scores.quality_score,
			StrategyGateConfig.SATELLITE_QUALITY_MIN,
		) &&
		(scoreAtLeast(
			scores.upside_score,
			StrategyGateConfig.SATELLITE_UPSIDE_MIN,
		) ||
			scoreAtLeast(
				scores.tactical_score,
				StrategyGateConfig.SATELLITE_TACTICAL_MIN,
			))
	);
}

function passesDefenseGate(
	scores: Record<string, number | undefined>,
): boolean {
	return (
		scoreAtLeast(
			scores.overall_score,
			StrategyGateConfig.DEFENSE_OVERALL_MIN,
		) &&
		scoreAtLeast(
			scores.quality_score,
			StrategyGateConfig.DEFENSE_QUALITY_MIN,
		) &&
		scoreAtLeast(
			scores.valuation_score,
			StrategyGateConfig.DEFENSE_VALUATION_MIN,
		) &&
		scoreAtLeast(scores.size_score, StrategyGateConfig.DEFENSE_SIZE_MIN)
	);
}

function passesStableDefenseGate(
	scores: Record<string, number | undefined>,
): boolean {
	return (
		scoreAtLeast(
			scores.overall_score,
			StrategyGateConfig.DEFENSE_OVERALL_MIN,
		) &&
		scoreAtLeast(
			scores.moat_score,
			StrategyGateConfig.STABLE_DEFENSE_MOAT_MIN,
		) &&
		scoreAtLeast(
			scores.quality_score,
			StrategyGateConfig.STABLE_DEFENSE_QUALITY_MIN,
		) &&
		scoreAtLeast(
			scores.valuation_score,
			StrategyGateConfig.STABLE_DEFENSE_VALUATION_MIN,
		) &&
		scoreAtMost(
			scores.tactical_score,
			StrategyGateConfig.STABLE_DEFENSE_TACTICAL_MAX,
		) &&
		scoreAtMost(
			scores.upside_score,
			StrategyGateConfig.STABLE_DEFENSE_UPSIDE_MAX,
		)
	);
}

function hasSpeculationWeakness(
	scores: Record<string, number | undefined>,
): boolean {
	return (
		scoreAtMost(
			scores.overall_score,
			StrategyGateConfig.SPECULATION_OVERALL_MAX,
		) ||
		scoreAtMost(scores.moat_score, StrategyGateConfig.SPECULATION_MOAT_MAX) ||
		scoreAtMost(
			scores.quality_score,
			StrategyGateConfig.SPECULATION_QUALITY_MAX,
		) ||
		scoreAtMost(
			scores.valuation_score,
			StrategyGateConfig.SPECULATION_VALUATION_MAX,
		)
	);
}

function gatedStrategyLabel(
	scores: Record<string, number | undefined>,
): string {
	if (passesCoreGate(scores)) {
		return "Core";
	}
	if (passesDefenseGate(scores) || passesStableDefenseGate(scores)) {
		return "Defense";
	}
	if (passesSatelliteGate(scores)) {
		return "Satellite";
	}
	if (hasSpeculationWeakness(scores)) {
		return "Speculation";
	}
	return DEFAULT_BUCKET;
}

/** Derive dashboard strategy label from a normalized evaluation entry. */
export function bucketFromEvaluation(
	ticker: string,
	data: Record<string, unknown> | null | undefined,
): string | null {
	void ticker;

	const normalized = normalizeEvaluation(data);
	if (Object.keys(normalized).length === 0) {
		return null;
	}

	const scores = {
		moat_score: normalized.moat_score,
		quality_score: normalized.quality_score,
		valuation_score: normalized.valuation_score,
		upside_score: normalized.upside_score,
		tactical_score: normalized.tactical_score,
		size_score: normalized.market_cap_score,
	};

	return gatedStrategyLabel({
		...scores,
		overall_score: normalized.overall_score,
	});
}
