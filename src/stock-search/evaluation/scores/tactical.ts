/** Score short-to-medium-term setup without changing durable fundamentals. */

import { TacticalScoreMultipliers } from "../constants.js";
import { getNumberField, type IndicatorLike, statCurveScore, weightedMeanScore } from "./shared.js";
import {
  tacticalActivityScore,
  tacticalGrowthScore,
  tacticalMomentumScore,
} from "./tactical-signals.js";
import { calculateValuationScore } from "./valuation.js";

export function calculateTacticalScore(
  indicator: IndicatorLike,
  analystTargetGap: number | null,
): number | null {
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
    [calculateValuationScore(indicator), TacticalScoreMultipliers.VALUATION],
    [statCurveScore(analystTargetGap, "median_upside"), TacticalScoreMultipliers.MEDIAN_UPSIDE],
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
