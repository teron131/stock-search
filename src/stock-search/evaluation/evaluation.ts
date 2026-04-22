/** Blend evaluation signals into scores and probabilities. */

import {
	ELO_K_FACTOR,
	EXPECTED_DRAW_WEIGHT,
	QUALITY_RESEARCH_WEIGHT,
	QUALITY_SIGNAL_WEIGHT,
	ROUND_PROBABILITY_DIGITS,
	SCORE_SCALE,
} from "./constants.js";
import {
	bucketFromEvalJson,
	evalFromJson,
	normalizeEvalJson,
} from "./normalization.js";
import {
	calculateCombinedUpsideScore,
	calculateEloDelta,
	calculateQualitySignalScore,
	calculateStrategyIndices,
	calculateValuationScore,
	checkFomoConditions,
	getGameTier,
	marketCapScore,
	modelProbabilities,
} from "./scores.js";
import type {
	Evaluation,
	FutureOutlook,
	ResearchEvaluation,
	ScoredReason,
} from "../models/schemas.js";
import { FUTURE_OUTLOOK_DEFINITION, RESEARCH_DEFINITION } from "../prompts.js";
import { normalizeTicker } from "../utils.js";
import { fetchLiveIndicators } from "../indicators.js";
import { runLlmEvaluation } from "./research.js";

export type EvaluationResult = {
	inputs: Evaluation;
	ticker: string | null;
	pUp: number | null;
	pDown: number | null;
	pFlat: number | null;
	edge: number | null;
	confidence: number | null;
	overall: number | null;
	eloDelta: number | null;
	eloDeltaDir: number | null;
	eloDeltaExp: number | null;
	coreIndex: number | null;
	satelliteIndex: number | null;
	speculativeIndex: number | null;
	diversifierIndex: number | null;
	fomoFlag: boolean;
	gameTier: string;
};

function probabilitiesFromScores(
	bullScore: number | null,
	bearScore: number | null,
): [number | null, number | null, number | null] {
	const bullProbability =
		bullScore == null
			? null
			: Number((bullScore / SCORE_SCALE).toFixed(ROUND_PROBABILITY_DIGITS));
	const bearProbability =
		bearScore == null
			? null
			: Number((bearScore / SCORE_SCALE).toFixed(ROUND_PROBABILITY_DIGITS));

	let flatProbability: number | null = null;
	if (bullProbability != null && bearProbability != null) {
		flatProbability = Math.max(
			0,
			Number((1 - bullProbability - bearProbability).toFixed(ROUND_PROBABILITY_DIGITS)),
		);
	}
	return [bullProbability, bearProbability, flatProbability];
}

function flatProbability(
	bullProbability: number | null,
	bearProbability: number | null,
): number | null {
	if (bullProbability == null || bearProbability == null) {
		return null;
	}
	return Math.max(0, 1 - bullProbability - bearProbability);
}

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

/** Fetch metrics and run LLM evaluations to build the Evaluation input model. */
export async function buildInputs(ticker: string): Promise<Evaluation> {
	const normalizedTicker = normalizeTicker(ticker);
	const indicator = await fetchLiveIndicators(normalizedTicker);

	const outlook = await runLlmEvaluation(
		ticker,
		FUTURE_OUTLOOK_DEFINITION,
		(await import("../models/schemas.js")).futureOutlookSchema,
	);
	const research = await runLlmEvaluation(
		ticker,
		RESEARCH_DEFINITION,
		(await import("../models/schemas.js")).researchEvaluationSchema,
	);

	const marketCapValue = marketCapScore({
		marketCap: indicator.market_cap,
		quoteType: indicator.quote_type,
	});
	const valuationScore = calculateValuationScore(indicator);
	const qualitySignalScore = calculateQualitySignalScore(indicator);
	const upsideScore = calculateCombinedUpsideScore(
		typeof indicator.median_upside === "number" ? indicator.median_upside : null,
		Array.isArray(indicator.ratings)
			? (indicator.ratings as Array<Record<string, unknown>>)
			: null,
		outlook?.score ?? null,
	);

	const [bullScore, bearScore] = modelProbabilities(indicator, outlook);
	const [bullProbability, bearProbability, flatProbabilityValue] =
		probabilitiesFromScores(bullScore, bearScore);

	const quality = blendedQuality(research, qualitySignalScore);

	return {
		score: outlook?.score ?? null,
		reasons: outlook?.reasons ?? [],
		market_cap_score: marketCapValue,
		valuation_score: valuationScore,
		upside_score: upsideScore,
		bull_probability: bullProbability,
		bear_probability: bearProbability,
		flat_probability: flatProbabilityValue,
		moat_score: research?.moat_score ?? null,
		quality_score: quality,
	};
}

/** Process an Evaluation model into a final EvaluationResult with indices and deltas. */
export function evaluateAsset(
	inputs: Evaluation,
	ticker: string | null = null,
): EvaluationResult {
	const bullProbability = inputs.bull_probability ?? null;
	const bearProbability = inputs.bear_probability ?? null;
	const pFlat =
		inputs.flat_probability ?? flatProbability(bullProbability, bearProbability);

	const bullScore =
		bullProbability == null ? null : bullProbability * SCORE_SCALE;
	const bearScore =
		bearProbability == null ? null : bearProbability * SCORE_SCALE;
	const edge =
		bullScore != null && bearScore != null ? bullScore - bearScore : null;

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
	const overall = coreMetrics.every((value) => value != null)
		? coreMetrics.reduce((sum, value) => sum + Number(value), 0) / 4
		: null;

	const indices = calculateStrategyIndices(scores, edge);
	const fomoFlag = checkFomoConditions(scores, bullScore);
	const eloDirectionDelta =
		bullProbability != null &&
		bearProbability != null &&
		bullProbability > 0 &&
		bearProbability > 0
			? ELO_K_FACTOR * Math.log10(bullProbability / bearProbability)
			: null;
	const expectedProbability =
		bullProbability != null && pFlat != null
			? bullProbability + EXPECTED_DRAW_WEIGHT * pFlat
			: null;

	return {
		inputs,
		ticker,
		pUp: bullProbability,
		pDown: bearProbability,
		pFlat,
		edge,
		confidence: edge == null ? null : Math.abs(edge),
		overall,
		eloDelta: calculateEloDelta(bullProbability),
		eloDeltaDir: eloDirectionDelta,
		eloDeltaExp: calculateEloDelta(expectedProbability),
		coreIndex: indices.core ?? null,
		satelliteIndex: indices.satellite ?? null,
		speculativeIndex: indices.speculative ?? null,
		diversifierIndex: indices.diversifier ?? null,
		fomoFlag,
		gameTier: getGameTier(bullScore),
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

export {
	bucketFromEvalJson,
	evalFromJson,
	normalizeEvalJson,
	bucketFromEvalJson as bucketFromEvaluation,
	normalizeEvalJson as normalizeEvaluationRow,
};
