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
import { calculateStrategyIndices } from "./scores.js";

const BUCKET_LABELS: Record<string, string> = {
	core: "Core",
	satellite: "Satellite",
	speculative: "Speculation",
	diversifier: "Defense",
};
const DEFAULT_BUCKET = "Speculation";

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

	return {
		overall_score: toFloat(data.overall_score, DEFAULT_SCORE),
		quality_score: toFloat(data.quality_score, DEFAULT_SCORE),
		moat_score: toFloat(data.moat_score, DEFAULT_SCORE),
		valuation_score: toFloat(data.valuation_score, DEFAULT_SCORE),
		upside_score: toFloat(data.upside_score, DEFAULT_SCORE),
		market_cap_score: toFloat(data.market_cap_score, DEFAULT_SCORE),
		bull_probability: bullProbability,
		bear_probability: bearProbability,
		flat_probability: toFloat(data.flat_probability, computedFlatProbability),
	};
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
export const bucketFromEvaluation = bucketFromEvalJson;
