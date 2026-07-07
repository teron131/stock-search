/** Blend evaluation signals into scores and strategy indices. */

import type { ZodType, z } from "zod";
import { fetchLiveIndicators } from "../indicators.js";
import type { Evaluation, ScoredReason } from "../models/schemas.js";
import { FUTURE_OUTLOOK_DEFINITION, RESEARCH_DEFINITION } from "../prompts.js";
import { normalizeTicker } from "../utils.js";
import {
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
	calculateOverallScore,
	calculateQualitySignalScore,
	calculateStrategyIndices,
	calculateValuationScore,
	marketCapScore,
} from "./scores/index.js";

export type EvaluationResult = {
	inputs: Evaluation;
	ticker: string | null;
	overall: number | null;
	coreIndex: number | null;
	satelliteIndex: number | null;
	speculativeIndex: number | null;
	diversifierIndex: number | null;
};

function blendedResearchSignal({
	researchScore,
	signalScore,
	researchWeight,
	signalWeight,
	reasons,
}: {
	researchScore: number | null;
	signalScore: number | null;
	researchWeight: number;
	signalWeight: number;
	reasons: string[];
}): ScoredReason | null {
	if (researchScore == null && signalScore == null) {
		return null;
	}

	let score: number;
	if (researchScore != null && signalScore != null) {
		score = Number(
			(researchWeight * researchScore + signalWeight * signalScore).toFixed(2),
		);
	} else if (researchScore != null) {
		score = Number(researchScore.toFixed(2));
	} else {
		score = Number((signalScore ?? 0).toFixed(2));
	}

	return {
		score,
		reasons,
	};
}

async function runOptionalLlmEvaluation<T extends ZodType>(
	ticker: string,
	systemPrompt: string,
	responseFormat: T,
): Promise<z.infer<T> | null> {
	try {
		return await runLlmEvaluation(ticker, systemPrompt, responseFormat);
	} catch {
		return null;
	}
}

/** Fetch metrics and run LLM evaluations to build the Evaluation input model. */
export async function buildInputs(ticker: string): Promise<Evaluation> {
	const normalizedTicker = normalizeTicker(ticker);
	const [indicator, schemas] = await Promise.all([
		fetchLiveIndicators(normalizedTicker),
		import("../models/schemas.js"),
	]);
	const [outlook, research] = await Promise.all([
		runOptionalLlmEvaluation(
			ticker,
			FUTURE_OUTLOOK_DEFINITION,
			schemas.FutureOutlookSchema,
		),
		runOptionalLlmEvaluation(
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

	const quality = blendedResearchSignal({
		researchScore: research?.quality_score?.score ?? null,
		signalScore: qualitySignalScore,
		researchWeight: QUALITY_RESEARCH_WEIGHT,
		signalWeight: QUALITY_SIGNAL_WEIGHT,
		reasons: research?.quality_score?.reasons ?? [],
	});
	const moat = blendedResearchSignal({
		researchScore: research?.moat_score?.score ?? null,
		signalScore: moatSignalScore,
		researchWeight: MOAT_RESEARCH_WEIGHT,
		signalWeight: MOAT_SIGNAL_WEIGHT,
		reasons: research?.moat_score?.reasons ?? [],
	});

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

	const overall = calculateOverallScore(scores);

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
