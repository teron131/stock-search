/** Normalize evaluation payloads into the dashboard schema. */

import { toFloat } from "../common-utils.js";
import type { Evaluation, ScoredReason } from "../models/schemas.js";
import {
	DEFAULT_BEAR_PROBABILITY,
	DEFAULT_BULL_PROBABILITY,
	DEFAULT_SCORE,
	ROUND_PROBABILITY_DIGITS,
	SCORE_SCALE,
} from "./constants.js";
import {
	calculateCombinedUpsideScore,
	calculateQualitySignalScore,
	calculateStrategyIndices,
	calculateValuationScore,
	marketCapScore,
} from "./scores.js";

const BUCKET_LABELS: Record<string, string> = {
	core: "Core",
	satellite: "Satellite",
	speculative: "Speculation",
	diversifier: "Defense",
};
const DEFAULT_BUCKET = "Speculation";
const SCORE_DIGITS = 2;

function roundScore(value: number | null): number | null {
	return value == null || !Number.isFinite(value)
		? null
		: Number(value.toFixed(SCORE_DIGITS));
}

function averageScore(values: Array<number | null | undefined>): number | null {
	if (values.some((value) => value == null || !Number.isFinite(value))) {
		return null;
	}
	const numericValues = values.map((value) => Number(value));
	return roundScore(
		numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length,
	);
}

function scoreFromEvaluationField(value: unknown): number | null {
	if (typeof value === "object" && value !== null && "score" in value) {
		return scoreFromEvaluationField((value as { score?: unknown }).score);
	}
	const converted = Number(value);
	return Number.isFinite(converted) ? converted : null;
}

/** Normalize an eval.json entry to canonical keys used by the app. */
export function normalizeEvalJson(
	data: Record<string, unknown> | null | undefined,
): Record<string, number> {
	if (!data || Object.keys(data).length === 0) {
		return {};
	}

	const bullProbability = toFloat(
		data.bull_probability,
		DEFAULT_BULL_PROBABILITY,
	);
	const bearProbability = toFloat(
		data.bear_probability,
		DEFAULT_BEAR_PROBABILITY,
	);
	const computedFlatProbability = Math.max(
		0,
		Number(
			(1 - bullProbability - bearProbability).toFixed(ROUND_PROBABILITY_DIGITS),
		),
	);

	const normalized: Record<string, number> = {
		overall_score: toFloat(data.overall_score, DEFAULT_SCORE),
		moat_score: toFloat(data.moat_score, DEFAULT_SCORE),
		valuation_score: toFloat(data.valuation_score, DEFAULT_SCORE),
		upside_score: toFloat(data.upside_score, DEFAULT_SCORE),
		market_cap_score: toFloat(data.market_cap_score, DEFAULT_SCORE),
		bull_probability: bullProbability,
		bear_probability: bearProbability,
		flat_probability: toFloat(data.flat_probability, computedFlatProbability),
	};
	const llmQualityScore = roundScore(
		scoreFromEvaluationField(data.llm_quality_score),
	);
	if (llmQualityScore != null) {
		normalized.llm_quality_score = llmQualityScore;
		normalized.quality_score = llmQualityScore;
	}
	return normalized;
}

/** Normalize evaluation while refreshing deterministic scores from current stats. */
export function normalizeEvalJsonForIndicators(
	data: Record<string, unknown> | null | undefined,
	indicators: Record<string, unknown> | null | undefined,
): Record<string, number> {
	const normalized = normalizeEvalJson(data);
	const indicatorRow = indicators ?? {};

	const qualityScore = roundScore(calculateQualitySignalScore(indicatorRow));
	const llmQualityScore = roundScore(
		scoreFromEvaluationField(data?.llm_quality_score),
	);
	if (llmQualityScore != null) {
		normalized.llm_quality_score = llmQualityScore;
	}
	if (qualityScore != null || llmQualityScore != null) {
		normalized.quality_score = Math.max(
			qualityScore ?? Number.NEGATIVE_INFINITY,
			llmQualityScore ?? Number.NEGATIVE_INFINITY,
		);
	}

	const valuationScore = roundScore(calculateValuationScore(indicatorRow));
	if (valuationScore != null) {
		normalized.valuation_score = valuationScore;
	}

	const upsideScore = roundScore(
		calculateCombinedUpsideScore(
			typeof indicatorRow.median_upside === "number"
				? indicatorRow.median_upside
				: null,
			Array.isArray(indicatorRow.ratings)
				? (indicatorRow.ratings as Array<Record<string, unknown>>)
				: null,
			null,
		),
	);
	if (upsideScore != null) {
		normalized.upside_score = upsideScore;
	}

	const sizeScore = roundScore(marketCapScore(indicatorRow));
	if (sizeScore != null) {
		normalized.market_cap_score = sizeScore;
	}

	const overallScore = averageScore([
		normalized.quality_score,
		normalized.valuation_score,
		normalized.moat_score,
		normalized.upside_score,
	]);
	if (overallScore != null) {
		normalized.overall_score = overallScore;
	}

	return normalized;
}

/** Build an `Evaluation` model from an `eval.json` entry. */
export function evalFromJson(
	data: Record<string, unknown> | null | undefined,
): Evaluation | null {
	const normalized = normalizeEvalJson(data);
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
		bull_probability: normalized.bull_probability,
		bear_probability: normalized.bear_probability,
		flat_probability: normalized.flat_probability,
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

function strategyLabel(indices: Record<string, number | null>): string {
	const available = Object.entries(indices).filter(
		(entry): entry is [string, number] => entry[1] != null,
	);
	if (available.length === 0) {
		return DEFAULT_BUCKET;
	}
	const bestKey = available.sort((left, right) => right[1] - left[1])[0][0];
	return BUCKET_LABELS[bestKey] ?? DEFAULT_BUCKET;
}

/** Derive dashboard strategy label from a normalized `eval.json` entry. */
export function bucketFromEvalJson(
	ticker: string,
	data: Record<string, unknown> | null | undefined,
): string | null {
	void ticker;

	const normalized = normalizeEvalJson(data);
	if (Object.keys(normalized).length === 0) {
		return null;
	}

	const scores = {
		moat_score: normalized.moat_score,
		quality_score: normalized.quality_score,
		valuation_score: normalized.valuation_score,
		upside_score: normalized.upside_score,
		size_score: normalized.market_cap_score,
	};

	const bull = normalized.bull_probability;
	const bear = normalized.bear_probability;
	const edge =
		bull != null && bear != null
			? bull * SCORE_SCALE - bear * SCORE_SCALE
			: null;

	return strategyLabel(calculateStrategyIndices(scores, edge));
}

// Backward-compatible aliases for the rest of the TS app.
export const normalizeEvaluationRow = normalizeEvalJson;
export const normalizeEvaluationRowForIndicators =
	normalizeEvalJsonForIndicators;
export const bucketFromEvaluation = bucketFromEvalJson;
