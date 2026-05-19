/** Derived stat helpers used by live and family-based resolver paths. */

import { asNumber } from "../utils.js";

export const PEG_SOURCE_DERIVED_NTM_FORWARD_PE = "derived_ntm_forward_pe";
export const PEG_SOURCE_STOCKANALYSIS = "stockanalysis";
export const PEG_SOURCE_FINVIZ = "finviz";
export const PEG_SOURCE_BLEND = "blend";

const DERIVED_PEG_EXCLUDED_QUOTE_TYPES = new Set(["ETF", "MUTUALFUND"]);
const MIN_DERIVED_PEG_NTM_GROWTH_PERCENT = 5;
const PEG_SOURCE_MATCH_TOLERANCE = 0.005;
const TRUSTED_PEG_SOURCES = new Set([
	PEG_SOURCE_DERIVED_NTM_FORWARD_PE,
	PEG_SOURCE_STOCKANALYSIS,
	PEG_SOURCE_FINVIZ,
	PEG_SOURCE_BLEND,
]);

export type PegBlendSourceInput = {
	source: string;
	/** Source-native forward P/E. Only compare it with PEG from the same source. */
	pe_forward: unknown;
	peg: unknown;
};

export type PegBlendSource = {
	source: string;
	pe_forward: number;
	peg: number;
	/** Growth percentage implied by PEG = forward P/E / growth%, not a literal EPS estimate field. */
	peg_implied_growth_percent: number;
};

export type PegBlendResult = {
	mode: "none" | "single-source" | "blend";
	source: string | null;
	pe_forward: number | null;
	peg: number | null;
	peg_implied_growth_percent: number | null;
	source_count: number;
	implied_growth_spread_ratio: number | null;
	confidence: "none" | "single-source" | "high" | "medium" | "low";
	sources: PegBlendSource[];
};

function asPositiveNumber(value: unknown): number | null {
	const number = asNumber(value);
	return number != null && number > 0 ? number : null;
}

function pegBlendSource(input: PegBlendSourceInput): PegBlendSource | null {
	const forwardPe = asPositiveNumber(input.pe_forward);
	const peg = asPositiveNumber(input.peg);
	if (forwardPe == null || peg == null) {
		return null;
	}

	return {
		source: input.source,
		pe_forward: forwardPe,
		peg,
		peg_implied_growth_percent: forwardPe / peg,
	};
}

function mean(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function assignDerivedPeg(indicators: Record<string, unknown>): void {
	const derivedPeg = derivePegFromNtmForwardPe(indicators);
	indicators.peg = derivedPeg;
	indicators.peg_source =
		derivedPeg == null ? null : PEG_SOURCE_DERIVED_NTM_FORWARD_PE;
}

function isDerivedPegValue(
	indicators: Record<string, unknown>,
	peg: number,
): boolean {
	const derivedPeg = derivePegFromNtmForwardPe(indicators);
	return (
		derivedPeg != null &&
		Math.abs(derivedPeg - peg) <= PEG_SOURCE_MATCH_TOLERANCE
	);
}

export function derivePegFromNtmForwardPe(
	indicators: Record<string, unknown>,
): number | null {
	const quoteType = String(indicators.quote_type ?? "")
		.trim()
		.toUpperCase();
	if (DERIVED_PEG_EXCLUDED_QUOTE_TYPES.has(quoteType)) {
		return null;
	}

	const pe = asNumber(indicators.pe);
	const forwardPe = asNumber(indicators.pe_forward);
	if (pe == null || forwardPe == null || pe <= 0 || forwardPe <= 0) {
		return null;
	}

	const ntmGrowthPercent = (pe / forwardPe - 1) * 100;
	if (ntmGrowthPercent < MIN_DERIVED_PEG_NTM_GROWTH_PERCENT) {
		return null;
	}
	return Number((pe / ntmGrowthPercent).toFixed(2));
}

/**
 * Blend PEG by averaging each source's own PEG-implied growth.
 *
 * This intentionally does not use literal EPS next-year or next-5Y fields.
 * For each source, growth% = source pe_forward / source peg, then the blended
 * PEG is average pe_forward / average PEG-implied growth%.
 */
export function blendImpliedGrowthPeg(
	inputs: PegBlendSourceInput[],
): PegBlendResult {
	const sources = inputs.map(pegBlendSource).filter((source) => source != null);

	if (sources.length === 0) {
		return {
			mode: "none",
			source: null,
			pe_forward: null,
			peg: null,
			peg_implied_growth_percent: null,
			source_count: 0,
			implied_growth_spread_ratio: null,
			confidence: "none",
			sources: [],
		};
	}

	if (sources.length === 1) {
		const [source] = sources;
		return {
			mode: "single-source",
			source: source.source,
			pe_forward: source.pe_forward,
			peg: source.peg,
			peg_implied_growth_percent: source.peg_implied_growth_percent,
			source_count: 1,
			implied_growth_spread_ratio: null,
			confidence: "single-source",
			sources,
		};
	}

	const forwardPe = mean(sources.map((source) => source.pe_forward));
	const impliedGrowth = mean(
		sources.map((source) => source.peg_implied_growth_percent),
	);
	const minGrowth = Math.min(
		...sources.map((source) => source.peg_implied_growth_percent),
	);
	const maxGrowth = Math.max(
		...sources.map((source) => source.peg_implied_growth_percent),
	);
	const growthSpread = (maxGrowth - minGrowth) / impliedGrowth;

	return {
		mode: "blend",
		source: "blend",
		pe_forward: forwardPe,
		peg: forwardPe / impliedGrowth,
		peg_implied_growth_percent: impliedGrowth,
		source_count: sources.length,
		implied_growth_spread_ratio: growthSpread,
		confidence:
			growthSpread < 0.1 ? "high" : growthSpread < 0.2 ? "medium" : "low",
		sources,
	};
}

export function applyDerivedPegFallback(
	indicators: Record<string, unknown>,
): void {
	if (asPositiveNumber(indicators.peg) != null) {
		indicators.peg_source = indicators.peg_source ?? null;
		return;
	}
	assignDerivedPeg(indicators);
}

export function applyPrimaryPegFallback(
	indicators: Record<string, unknown>,
	primaryFields: Record<string, unknown>,
): void {
	const primaryPeg = asPositiveNumber(primaryFields.peg);
	if (primaryPeg != null) {
		indicators.peg = primaryPeg;
		indicators.peg_source = PEG_SOURCE_STOCKANALYSIS;
		return;
	}

	assignDerivedPeg(indicators);
}

export function applySourcePegFallback(
	indicators: Record<string, unknown>,
	inputs: PegBlendSourceInput[],
): void {
	const result = blendImpliedGrowthPeg(inputs);
	if (result.peg != null && result.source != null) {
		indicators.peg = Number(result.peg.toFixed(2));
		indicators.peg_source =
			result.mode === "blend" ? PEG_SOURCE_BLEND : result.source;
		return;
	}

	for (const input of inputs) {
		const sourcePeg = asPositiveNumber(input.peg);
		if (sourcePeg != null) {
			indicators.peg = sourcePeg;
			indicators.peg_source = input.source;
			return;
		}
	}

	assignDerivedPeg(indicators);
}

export function applyCachedPegFallback(
	indicators: Record<string, unknown>,
): void {
	if (TRUSTED_PEG_SOURCES.has(String(indicators.peg_source ?? ""))) {
		return;
	}
	const cachedPeg = asPositiveNumber(indicators.peg);
	if (cachedPeg != null) {
		indicators.peg_source = isDerivedPegValue(indicators, cachedPeg)
			? PEG_SOURCE_DERIVED_NTM_FORWARD_PE
			: null;
		return;
	}

	assignDerivedPeg(indicators);
}
