/** Provide shared math helpers for evaluation scoring. */

function erf(value: number): number {
	const sign = value < 0 ? -1 : 1;
	const absValue = Math.abs(value);
	const a1 = 0.254829592;
	const a2 = -0.284496736;
	const a3 = 1.421413741;
	const a4 = -1.453152027;
	const a5 = 1.061405429;
	const p = 0.3275911;
	const t = 1 / (1 + p * absValue);
	const y =
		1 -
		((((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
			Math.exp(-absValue * absValue));
	return sign * y;
}

/** Clamp score to valid range [0, 10] and round to 2 decimals. */
export function clampScore(value: number): number {
	if (value < 0) {
		return 0;
	}
	if (value > 10) {
		return 10;
	}
	return Math.round(value * 100) / 100;
}

/** Map a value using a Normal CDF (S-curve) based on piecewise Z-scores. */
export function zScoreMap(
	value: number,
	inMin: number,
	inMax: number,
	inMedian: number,
	outMin = 0,
	outMax = 10,
): number {
	if (value <= inMin) {
		return outMin;
	}
	if (value >= inMax) {
		return outMax;
	}

	const sigma =
		(value <= inMedian ? inMedian - inMin : inMax - inMedian) / 3;
	const z = sigma > 0 ? (value - inMedian) / sigma : 0;
	const phi = 0.5 * (1 + erf(z / Math.sqrt(2)));
	return clampScore(outMin + (outMax - outMin) * phi);
}
