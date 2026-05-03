/** Normalize monetary fundamentals to the app's canonical USD shape. */

import { asNumber } from "./utils.js";

const FX_MONETARY_FIELDS = ["market_cap", "free_cash_flow"] as const;

function isEtfRow(fields: Record<string, unknown>): boolean {
	return (
		String(fields.quote_type ?? fields.equity_type ?? "")
			.trim()
			.toUpperCase() === "ETF"
	);
}

/** Convert non-price monetary fields in-place when an FX rate is available. */
export function normalizeMonetaryFields(fields: Record<string, unknown>): void {
	if (isEtfRow(fields)) {
		fields.market_cap = null;
		fields.fx = null;
		return;
	}

	const marketCap = asNumber(fields.market_cap);
	const fx = asNumber(fields.fx);
	if (marketCap == null) {
		fields.fx = null;
		return;
	}

	if (fx != null) {
		for (const field of FX_MONETARY_FIELDS) {
			const value = asNumber(fields[field]);
			if (value != null) {
				fields[field] = Math.round(value * fx);
			}
		}
		fields.fx = fx;
		return;
	}

	fields.fx = null;
}

/** Fill missing monetary fields from a fallback source, then normalize. */
export function mergeAndNormalizeMonetaryFields(
	row: Record<string, unknown>,
	fallback: Record<string, unknown>,
): Record<string, unknown> {
	if (isEtfRow(row) || isEtfRow(fallback)) {
		const output = {
			...row,
			quote_type: row.quote_type ?? fallback.quote_type,
		};
		normalizeMonetaryFields(output);
		return output;
	}

	const fallbackFx = asNumber(fallback.fx);
	const output: Record<string, unknown> = {
		...row,
		fx: fallbackFx,
	};
	let convertedFallbackField = false;
	for (const field of FX_MONETARY_FIELDS) {
		if (fallbackFx != null || asNumber(output[field]) == null) {
			const fallbackValue = asNumber(fallback[field]);
			if (fallbackValue != null) {
				output[field] =
					fallbackFx != null
						? Math.round(fallbackValue * fallbackFx)
						: fallbackValue;
				convertedFallbackField ||= fallbackFx != null;
			}
		}
	}
	output.fx = convertedFallbackField ? fallbackFx : null;
	return output;
}
