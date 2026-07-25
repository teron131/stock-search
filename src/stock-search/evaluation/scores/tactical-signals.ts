/** Score tactical setup signals that do not depend on valuation. */

import { SCORE_SCALE, TacticalScoreMultipliers } from "../constants.js";
import { mapToCurveScore } from "../math-utils.js";
import { getNumberField, type IndicatorLike, statCurveScore, weightedMeanScore } from "./shared.js";

export function tacticalGrowthScore(
  value: number | null,
  anchorKey: "revenue_growth" | "eps_growth",
): number | null {
  const score = statCurveScore(value, anchorKey);
  return score == null ? null : Math.min(score, SCORE_SCALE);
}

export function tacticalMomentumScore(value: number | null): number | null {
  return value == null
    ? null
    : mapToCurveScore(value, -50, 250, 50, {
        outMin: 0,
        outMax: SCORE_SCALE,
      });
}

export function tacticalActivityScore(
  value: number | null,
  range: [number, number, number],
): number | null {
  if (value == null) {
    return null;
  }
  const [rangeMin, rangeMedian, rangeMax] = range;
  return mapToCurveScore(value, rangeMin, rangeMax, rangeMedian);
}

export function tacticalSetupWithoutValuationScore(indicator: IndicatorLike): number | null {
  return weightedMeanScore([
    [
      tacticalMomentumScore(getNumberField(indicator, "change_percent_1y")),
      TacticalScoreMultipliers.PRICE_MOMENTUM_1Y,
    ],
    [
      tacticalMomentumScore(getNumberField(indicator, "change_percent_6m")),
      TacticalScoreMultipliers.PRICE_MOMENTUM_6M,
    ],
    [
      tacticalGrowthScore(getNumberField(indicator, "revenue_growth"), "revenue_growth"),
      TacticalScoreMultipliers.REVENUE_GROWTH,
    ],
    [
      tacticalGrowthScore(getNumberField(indicator, "eps_growth"), "eps_growth"),
      TacticalScoreMultipliers.EPS_GROWTH,
    ],
    [
      tacticalActivityScore(getNumberField(indicator, "rsi"), [30, 55, 85]),
      TacticalScoreMultipliers.RSI_ACTIVITY,
    ],
    [
      tacticalActivityScore(getNumberField(indicator, "iv"), [20, 45, 90]),
      TacticalScoreMultipliers.IV_ACTIVITY,
    ],
  ]);
}
