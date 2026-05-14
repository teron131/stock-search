/** Common utility functions used across the stock-search codebase.

This module consolidates frequently duplicated helper functions to reduce
code repetition and maintain consistent behavior.
*/

const MARKET_CAP_UNITS: ReadonlyArray<readonly [number, string]> = [
	[1_000_000_000_000, "T"],
	[1_000_000_000, "B"],
	[1_000_000, "M"],
	[1_000, "K"],
];

/** Safely parse finite float values from any input. */
export function safeFloat(value: unknown): number | null {
	const converted = Number(value);
	return Number.isFinite(converted) ? converted : null;
}

/** Round a float value to specified decimals, preserving null. */
export function roundOptional(
	value: number | null,
	decimals = 2,
): number | null {
	return value == null ? null : Number(value.toFixed(decimals));
}

/** Clamp a value to a specified range. */
export function clamp(value: number, minVal: number, maxVal: number): number {
	return Math.max(minVal, Math.min(maxVal, value));
}

/** Convert value to float with a fallback default. */
export function toFloat(value: unknown, defaultValue: number): number {
	const converted = Number(value);
	return Number.isFinite(converted) ? converted : defaultValue;
}

/** Format market cap with T/B/M/K suffix. */
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
