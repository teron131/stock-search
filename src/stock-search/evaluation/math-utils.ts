/** Provide shared math helpers for evaluation scoring. */

function approximateErrorFunction(value: number): number {
	const sign = value < 0 ? -1 : 1;
	const absValue = Math.abs(value);
	// Abramowitz-Stegun approximation for the Gauss error function, used by the Normal CDF score curve.
	const a1 = 0.254829592;
	const a2 = -0.284496736;
	const a3 = 1.421413741;
	const a4 = -1.453152027;
	const a5 = 1.061405429;
	const p = 0.3275911;
	const t = 1 / (1 + p * absValue);
	const y =
		1 -
		((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
			t *
			Math.exp(-absValue * absValue);
	return sign * y;
}

/** Clamp a score-like value to a bounded range and round to 2 decimals. */
export function clampScore(value: number, min = 0, max = 10): number {
	if (value < min) {
		return min;
	}
	if (value > max) {
		return max;
	}
	return Math.round(value * 100) / 100;
}

type CurveScoreOptions = {
	outMin?: number;
	outMax?: number;
	clampMin?: number;
	clampMax?: number;
};

/** Map a value to a smooth score using min/median/max anchors and a Normal CDF curve. */
export function mapToCurveScore(
	value: number,
	inMin: number,
	inMax: number,
	inMedian: number,
	options: CurveScoreOptions = {},
): number {
	const { outMin = 0, outMax = 10, clampMin = 0, clampMax = 10 } = options;

	if (value <= inMin) {
		return clampScore(outMin, clampMin, clampMax);
	}
	if (value >= inMax) {
		return clampScore(outMax, clampMin, clampMax);
	}

	const curveScale =
		(value <= inMedian ? inMedian - inMin : inMax - inMedian) / 3;
	const curvePosition = curveScale > 0 ? (value - inMedian) / curveScale : 0;
	const curvePercentile =
		0.5 * (1 + approximateErrorFunction(curvePosition / Math.sqrt(2)));
	return clampScore(
		outMin + (outMax - outMin) * curvePercentile,
		clampMin,
		clampMax,
	);
}
