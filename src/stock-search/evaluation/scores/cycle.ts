/** Detect cycle and overheat risk used to cap otherwise strong scores. */

import { CycleNormalizationConfig, DEFAULT_SCORE, OverheatSignalConfig } from "../constants.js";
import { getNumberField, type IndicatorLike, weightedMeanUnit } from "./shared.js";

function rampSignal(value: number | null, start: number, full: number): number | null {
  if (value == null) {
    return null;
  }
  if (value <= start) {
    return 0;
  }
  if (value >= full) {
    return 1;
  }
  return (value - start) / (full - start);
}

function inverseRampSignal(value: number | null, start: number, full: number): number | null {
  if (value == null) {
    return null;
  }
  if (value >= start) {
    return 0;
  }
  if (value <= full) {
    return 1;
  }
  return (start - value) / (start - full);
}

export function overheatRisk(indicator: IndicatorLike): number {
  const signals = [
    rampSignal(
      getNumberField(indicator, "revenue_growth"),
      OverheatSignalConfig.REVENUE_GROWTH_START,
      OverheatSignalConfig.REVENUE_GROWTH_FULL,
    ),
    rampSignal(
      getNumberField(indicator, "eps_growth"),
      OverheatSignalConfig.EPS_GROWTH_START,
      OverheatSignalConfig.EPS_GROWTH_FULL,
    ),
    rampSignal(
      getNumberField(indicator, "change_percent_1y"),
      OverheatSignalConfig.PRICE_1Y_START,
      OverheatSignalConfig.PRICE_1Y_FULL,
    ),
    rampSignal(
      getNumberField(indicator, "rsi"),
      OverheatSignalConfig.RSI_START,
      OverheatSignalConfig.RSI_FULL,
    ),
    rampSignal(
      getNumberField(indicator, "iv"),
      OverheatSignalConfig.IV_START,
      OverheatSignalConfig.IV_FULL,
    ),
  ].filter((signal): signal is number => signal != null);
  const activeSignals = signals.filter((signal) => signal > 0);
  if (activeSignals.length < OverheatSignalConfig.MIN_SIGNALS) {
    return 0;
  }
  return activeSignals.reduce((sum, signal) => sum + signal, 0) / signals.length;
}

export function hasTrendHistory(indicator: IndicatorLike): boolean {
  return [
    "revenue_growth_1y",
    "revenue_cagr_3y",
    "fcf_growth_1y",
    "fcf_cagr_3y",
    "gross_margin_median_3y",
    "operating_margin_median_3y",
    "operating_margin_std_3y",
    "fcf_margin_median_3y",
    "shares_change_1y",
    "shares_change_cagr_3y",
  ].some((fieldName) => getNumberField(indicator, fieldName) != null);
}

export function calculatePeakCycleRisk(indicator: IndicatorLike): number {
  const revenueGrowth1y =
    getNumberField(indicator, "revenue_growth_1y") ?? getNumberField(indicator, "revenue_growth");
  const revenueTrend = getNumberField(indicator, "revenue_cagr_3y");
  const revenueSpikeVsTrend =
    revenueGrowth1y == null || revenueTrend == null ? null : revenueGrowth1y - revenueTrend;
  const fcfGrowth1y = getNumberField(indicator, "fcf_growth_1y");
  const fcfTrend = getNumberField(indicator, "fcf_cagr_3y");
  const fcfSpikeVsTrend = fcfGrowth1y == null || fcfTrend == null ? null : fcfGrowth1y - fcfTrend;
  const revenueGrowthSpike = rampSignal(
    revenueSpikeVsTrend,
    CycleNormalizationConfig.GROWTH_SPIKE_START,
    CycleNormalizationConfig.GROWTH_SPIKE_FULL,
  );
  const fcfGrowthSpike = rampSignal(
    fcfSpikeVsTrend,
    CycleNormalizationConfig.GROWTH_SPIKE_START,
    CycleNormalizationConfig.GROWTH_SPIKE_FULL,
  );
  const growthSpike =
    revenueGrowthSpike == null && fcfGrowthSpike == null
      ? null
      : weightedMeanUnit([
          [revenueGrowthSpike, 0.7],
          [fcfGrowthSpike, 0.3],
        ]);
  const marginSpike = rampSignal(
    getNumberField(indicator, "operating_margin_delta_vs_3y"),
    CycleNormalizationConfig.MARGIN_SPIKE_START,
    CycleNormalizationConfig.MARGIN_SPIKE_FULL,
  );
  const marginVolatility = rampSignal(
    getNumberField(indicator, "operating_margin_std_3y"),
    CycleNormalizationConfig.MARGIN_STD_MEDIAN,
    CycleNormalizationConfig.MARGIN_STD_WEAK,
  );
  const earningsSpike = rampSignal(
    getNumberField(indicator, "eps_growth"),
    OverheatSignalConfig.EPS_GROWTH_START,
    OverheatSignalConfig.EPS_GROWTH_FULL,
  );
  const priceSpike = rampSignal(
    getNumberField(indicator, "change_percent_1y"),
    OverheatSignalConfig.PRICE_1Y_START,
    OverheatSignalConfig.PRICE_1Y_FULL,
  );
  const rsiSpike = rampSignal(
    getNumberField(indicator, "rsi"),
    OverheatSignalConfig.RSI_START,
    OverheatSignalConfig.RSI_FULL,
  );
  const ivSpike = rampSignal(
    getNumberField(indicator, "iv"),
    OverheatSignalConfig.IV_START,
    OverheatSignalConfig.IV_FULL,
  );
  const cheapForwardPe = inverseRampSignal(getNumberField(indicator, "pe_forward"), 18, 8);
  const cheapPeg = inverseRampSignal(getNumberField(indicator, "peg"), 1, 0.2);
  const earningsSpikeValue = earningsSpike ?? 0;
  const growthSpikeValue = growthSpike ?? 0;
  const earningsGrowthOrPriceSpikeValue = Math.max(
    earningsSpikeValue,
    growthSpikeValue,
    priceSpike ?? 0,
  );
  const falseCheapness = Math.max(
    (cheapForwardPe ?? 0) * Math.max(earningsSpikeValue, growthSpikeValue),
    (cheapPeg ?? 0) * earningsGrowthOrPriceSpikeValue,
  );

  return weightedMeanUnit([
    [growthSpike, 0.3],
    [marginSpike, 0.2],
    [falseCheapness, 0.35],
    [priceSpike, 0.15],
    [ivSpike, 0.1],
    [rsiSpike, 0.05],
    [marginVolatility, 0.1],
  ]);
}

export function pullScoreTowardNeutral(score: number, risk: number): number {
  if (score <= DEFAULT_SCORE || risk <= 0) {
    return score;
  }
  return score - (score - DEFAULT_SCORE) * risk * OverheatSignalConfig.VALUATION_PULL_TO_NEUTRAL;
}

export function applyHighCycleCap(score: number | null, risk: number, cap: number): number | null {
  if (score == null || risk < CycleNormalizationConfig.HIGH_RISK) {
    return score;
  }
  return Math.min(score, cap);
}
