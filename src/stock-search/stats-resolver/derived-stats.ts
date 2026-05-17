/** Derived stat helpers used by live and family-based resolver paths. */

import { asNumber } from "../utils.js";

export const PEG_SOURCE_DERIVED_NTM_FORWARD_PE = "derived_ntm_forward_pe";
export const PEG_SOURCE_STOCKANALYSIS = "stockanalysis";

const DERIVED_PEG_EXCLUDED_QUOTE_TYPES = new Set(["ETF", "MUTUALFUND"]);
const MIN_DERIVED_PEG_NTM_GROWTH_PERCENT = 5;
const TRUSTED_PEG_SOURCES = new Set([
	PEG_SOURCE_DERIVED_NTM_FORWARD_PE,
	PEG_SOURCE_STOCKANALYSIS,
]);

function asPositiveNumber(value: unknown): number | null {
	const number = asNumber(value);
	return number != null && number > 0 ? number : null;
}

function assignDerivedPeg(indicators: Record<string, unknown>): void {
	const derivedPeg = derivePegFromNtmForwardPe(indicators);
	indicators.peg = derivedPeg;
	indicators.peg_source =
		derivedPeg == null ? null : PEG_SOURCE_DERIVED_NTM_FORWARD_PE;
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

export function applyCachedPegFallback(
	indicators: Record<string, unknown>,
): void {
	if (TRUSTED_PEG_SOURCES.has(String(indicators.peg_source ?? ""))) {
		return;
	}
	if (asPositiveNumber(indicators.peg) != null) {
		indicators.peg_source = indicators.peg_source ?? null;
		return;
	}

	assignDerivedPeg(indicators);
}
