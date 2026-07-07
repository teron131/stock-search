/** Owns cross-domain numeric parsing, clamping, rounding, and market-cap formatting. */

const MARKET_CAP_UNITS: ReadonlyArray<readonly [number, string]> = [
	[1_000_000_000_000, "T"],
	[1_000_000_000, "B"],
	[1_000_000, "M"],
	[1_000, "K"],
];

/** Non-finite numeric inputs become null instead of leaking NaN into scores. */
export function safeFloat(value: unknown): number | null {
	const converted = Number(value);
	return Number.isFinite(converted) ? converted : null;
}

/** Nullable scoring inputs stay nullable while finite values get presentation rounding. */
export function roundOptional(
	value: number | null,
	decimals = 2,
): number | null {
	return value == null ? null : Number(value.toFixed(decimals));
}

/** Clamp callers share the same inclusive bound semantics. */
export function clamp(value: number, minVal: number, maxVal: number): number {
	return Math.max(minVal, Math.min(maxVal, value));
}

/** Parse a number with an explicit fallback for UI defaults and loose provider fields. */
export function toFloat(value: unknown, defaultValue: number): number {
	const converted = Number(value);
	return Number.isFinite(converted) ? converted : defaultValue;
}

/** Format large market caps with compact suffixes while preserving missing values. */
export function formatMarketCap(value: number | null): string | null {
	if (value == null) {
		return null;
	}

	const numericValue = Number(value);
	if (!Number.isFinite(numericValue)) {
		return null;
	}

	for (const [divisor, suffix] of MARKET_CAP_UNITS) {
		if (numericValue >= divisor) {
			return `${(numericValue / divisor).toFixed(3)}${suffix}`;
		}
	}

	return numericValue.toFixed(3);
}
