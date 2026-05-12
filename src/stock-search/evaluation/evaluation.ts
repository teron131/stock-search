/** Blend evaluation signals into scores and strategy indices. */

import { fetchLiveIndicators } from "../indicators.js";
import type {
	Evaluation,
	ResearchEvaluation,
	ScoredReason,
} from "../models/schemas.js";
import { FUTURE_OUTLOOK_DEFINITION, RESEARCH_DEFINITION } from "../prompts.js";
import { normalizeTicker } from "../utils.js";
import {
	DEFAULT_SCORE,
	MOAT_RESEARCH_WEIGHT,
	MOAT_SIGNAL_WEIGHT,
	QUALITY_RESEARCH_WEIGHT,
	QUALITY_SIGNAL_WEIGHT,
} from "./constants.js";
import {
	bucketFromEvaluation,
	evaluationFromRecord,
	normalizeEvaluation,
} from "./normalization.js";
import { runLlmEvaluation } from "./research.js";
import {
	calculateCombinedUpsideScore,
	calculateMoatSignalScore,
	calculateQualitySignalScore,
	calculateStrategyIndices,
	calculateValuationScore,
	marketCapScore,
} from "./scores.js";

export type EvaluationResult = {
	inputs: Evaluation;
	ticker: string | null;
	overall: number | null;
	coreIndex: number | null;
	satelliteIndex: number | null;
	speculativeIndex: number | null;
	diversifierIndex: number | null;
};

function blendedQuality(
	research: ResearchEvaluation | null,
	qualitySignalScore: number | null,
): ScoredReason | null {
	const researchQualityScore = research?.quality_score?.score ?? null;
	if (researchQualityScore == null && qualitySignalScore == null) {
		return null;
	}

	let score: number;
	if (researchQualityScore != null && qualitySignalScore != null) {
		score = Number(
			(
				QUALITY_RESEARCH_WEIGHT * researchQualityScore +
				QUALITY_SIGNAL_WEIGHT * qualitySignalScore
			).toFixed(2),
		);
	} else if (researchQualityScore != null) {
		score = Number(researchQualityScore.toFixed(2));
	} else {
		score = Number((qualitySignalScore ?? 0).toFixed(2));
	}

	return {
		score,
		reasons: research?.quality_score?.reasons ?? [],
	};
}

function blendedMoat(
	research: ResearchEvaluation | null,
	moatSignalScore: number | null,
): ScoredReason | null {
	const researchMoatScore = research?.moat_score?.score ?? null;
	if (researchMoatScore == null && moatSignalScore == null) {
		return null;
	}

	let score: number;
	if (researchMoatScore != null && moatSignalScore != null) {
		score = Number(
			(
				MOAT_RESEARCH_WEIGHT * researchMoatScore +
				MOAT_SIGNAL_WEIGHT * moatSignalScore
			).toFixed(2),
		);
	} else if (researchMoatScore != null) {
		score = Number(researchMoatScore.toFixed(2));
	} else {
		score = Number((moatSignalScore ?? 0).toFixed(2));
	}

	return {
		score,
		reasons: research?.moat_score?.reasons ?? [],
	};
}

function averageWithNeutralMissing(
	values: Array<number | null>,
): number | null {
	const availableScores = values.filter(
		(value): value is number => value != null && Number.isFinite(value),
	);
	if (availableScores.length === 0) {
		return null;
	}
	return (
		(availableScores.reduce((sum, value) => sum + value, 0) +
			(values.length - availableScores.length) * DEFAULT_SCORE) /
		values.length
	);
}

/** Fetch metrics and run LLM evaluations to build the Evaluation input model. */
export async function buildInputs(ticker: string): Promise<Evaluation> {
	const normalizedTicker = normalizeTicker(ticker);
	const [indicator, schemas] = await Promise.all([
		fetchLiveIndicators(normalizedTicker),
		import("../models/schemas.js"),
	]);
	const [outlook, research] = await Promise.all([
		runLlmEvaluation(
			ticker,
			FUTURE_OUTLOOK_DEFINITION,
			schemas.FutureOutlookSchema,
		),
		runLlmEvaluation(
			ticker,
			RESEARCH_DEFINITION,
			schemas.ResearchEvaluationSchema,
		),
	]);

	const marketCapValue = marketCapScore({
		marketCap: indicator.market_cap,
		quoteType: indicator.quote_type,
	});
	const valuationScore = calculateValuationScore(indicator);
	const qualitySignalScore = calculateQualitySignalScore(indicator);
	const moatSignalScore = calculateMoatSignalScore(indicator);
	const upsideScore = calculateCombinedUpsideScore(
		indicator,
		typeof indicator.median_upside === "number"
			? indicator.median_upside
			: null,
		Array.isArray(indicator.ratings)
			? (indicator.ratings as Array<Record<string, unknown>>)
			: null,
	);

	const quality = blendedQuality(research, qualitySignalScore);
	const moat = blendedMoat(research, moatSignalScore);

	return {
		score: outlook?.score ?? null,
		reasons: outlook?.reasons ?? [],
		market_cap_score: marketCapValue,
		valuation_score: valuationScore,
		upside_score: upsideScore,
		moat_score: moat,
		quality_score: quality,
	};
}

/** Process an Evaluation model into a final EvaluationResult with strategy indices. */
export function evaluateAsset(
	inputs: Evaluation,
	ticker: string | null = null,
): EvaluationResult {
	const scores = {
		moat_score: inputs.moat_score?.score ?? null,
		quality_score: inputs.quality_score?.score ?? null,
		valuation_score: inputs.valuation_score ?? null,
		upside_score: inputs.upside_score ?? null,
		size_score: inputs.market_cap_score ?? null,
	};

	const coreMetrics = [
		scores.moat_score,
		scores.quality_score,
		scores.valuation_score,
		scores.upside_score,
	];
	const overall = averageWithNeutralMissing(coreMetrics);

	const indices = calculateStrategyIndices(scores);

	return {
		inputs,
		ticker,
		overall,
		coreIndex: indices.core ?? null,
		satelliteIndex: indices.satellite ?? null,
		speculativeIndex: indices.speculative ?? null,
		diversifierIndex: indices.diversifier ?? null,
	};
}

/** Return the strategy label based on the highest index score. */
export function strategyLabel(
	core: number | null,
	satellite: number | null,
	speculative: number | null,
	diversifier: number | null,
): string {
	const strategyScores: Record<string, number | null> = {
		Core: core,
		Satellite: satellite,
		Speculation: speculative,
		Defense: diversifier,
	};

	const availableScores = Object.entries(strategyScores).filter(
		(entry): entry is [string, number] => entry[1] != null,
	);
	if (availableScores.length === 0) {
		return "Speculation";
	}

	return availableScores.sort((left, right) => right[1] - left[1])[0][0];
}

export { bucketFromEvaluation, evaluationFromRecord, normalizeEvaluation };
