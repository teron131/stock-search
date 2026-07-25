/** Builds user-facing correlation statistics and sleeve weight recommendations. */

import { DEFAULT_EFFECTIVE_SLEEVE_CAP, TRADING_DAYS_PER_YEAR } from "./constants.js";
import {
  buildReturnFrames,
  dedupePreserveOrder,
  isFiniteNumber,
  rowsFromFrame,
  valuesForTicker,
} from "./time-series.js";
import type {
  CorrelationMatrix,
  CorrelationReport,
  SleeveWeightRecommendation,
  TickerCorrelationStats,
  TimeSeriesFrame,
} from "./types.js";

function annualizedReturn(frame: TimeSeriesFrame, ticker: string): number | null {
  const clean = rowsFromFrame(frame)
    .map((row) => ({ date: row.date, value: row.values.get(ticker) }))
    .filter((row): row is { date: Date; value: number } => isFiniteNumber(row.value));
  if (clean.length === 0 || clean.some((row) => row.value <= -1)) {
    return null;
  }
  const logGrowth = clean.reduce((sum, row) => sum + Math.log1p(row.value), 0);
  const start = clean[0].date.getTime();
  const end = clean.at(-1)?.date.getTime() ?? start;
  const years = (end - start) / (365.25 * 24 * 60 * 60 * 1000);
  return years > 0 ? Math.expm1(logGrowth / years) : null;
}

function sampleStdDev(values: number[]): number | null {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) {
    return null;
  }
  const average = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  const variance =
    clean.reduce((sum, value) => sum + (value - average) ** 2, 0) / (clean.length - 1);
  return Math.sqrt(variance);
}

export function buildTickerStats(
  frame: TimeSeriesFrame,
  tickers: string[],
  names: Record<string, string>,
): TickerCorrelationStats[] {
  const returns = buildReturnFrames(frame);
  return tickers.map((ticker) => {
    const dailyStdDev = sampleStdDev(valuesForTicker(returns.daily, ticker));
    const monthlyStdDev = sampleStdDev(valuesForTicker(returns.monthly, ticker));
    return {
      name: names[ticker] ?? ticker,
      ticker,
      annualizedReturn: annualizedReturn(returns.daily, ticker),
      dailyStdDev,
      monthlyStdDev,
      annualizedStdDev: dailyStdDev == null ? null : dailyStdDev * Math.sqrt(TRADING_DAYS_PER_YEAR),
    };
  });
}

function asPercent(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

export function formatStatsPercent(
  stats: TickerCorrelationStats[],
): CorrelationReport["statsPercent"] {
  return stats.map((row) => ({
    name: row.name,
    ticker: row.ticker,
    annualizedReturn: asPercent(row.annualizedReturn),
    dailyStdDev: asPercent(row.dailyStdDev),
    monthlyStdDev: asPercent(row.monthlyStdDev),
    annualizedStdDev: asPercent(row.annualizedStdDev),
  }));
}

function meanPairCorrelation(matrix: CorrelationMatrix, members: string[]): number {
  if (members.length < 2) {
    return 0;
  }
  const indexes = members
    .map((member) => matrix.tickers.indexOf(member))
    .filter((index) => index >= 0);
  const values: number[] = [];
  for (const leftIndex of indexes) {
    for (const rightIndex of indexes) {
      if (leftIndex === rightIndex) {
        continue;
      }
      const value = matrix.values[leftIndex]?.[rightIndex];
      if (isFiniteNumber(value)) {
        values.push(value);
      }
    }
  }
  if (values.length === 0) {
    return 0;
  }
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.max(-0.99, Math.min(0.99, average));
}

export function buildSleeveWeightRecommendations({
  tickers,
  normalCorrelationMatrix,
  tailRawCorrelationMatrix,
  effectiveSleeveCap = DEFAULT_EFFECTIVE_SLEEVE_CAP,
  tickerMarkers,
}: {
  tickers: string[];
  normalCorrelationMatrix: CorrelationMatrix;
  tailRawCorrelationMatrix?: CorrelationMatrix;
  effectiveSleeveCap?: number;
  tickerMarkers?: Record<string, string[]>;
}): SleeveWeightRecommendation[] {
  const membersByMarker = new Map<string, string[]>();
  for (const ticker of tickers) {
    const markers = tickerMarkers?.[ticker] ?? [];
    for (const marker of Array.isArray(markers) ? markers : []) {
      const markerKey = marker.trim().toLowerCase();
      if (!markerKey) {
        continue;
      }
      membersByMarker.set(markerKey, [...(membersByMarker.get(markerKey) ?? []), ticker]);
    }
  }

  return [...membersByMarker.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([marker, members]) => {
      const uniqueMembers = dedupePreserveOrder(members);
      if (uniqueMembers.length < 2) {
        return [];
      }
      const normalMeanPairCorrelation = meanPairCorrelation(normalCorrelationMatrix, uniqueMembers);
      const tailMeanPairCorrelation = tailRawCorrelationMatrix
        ? meanPairCorrelation(tailRawCorrelationMatrix, uniqueMembers)
        : null;
      const meanPair =
        tailMeanPairCorrelation == null
          ? normalMeanPairCorrelation
          : Math.max(normalMeanPairCorrelation, tailMeanPairCorrelation);
      const varianceRatio = (1 + (uniqueMembers.length - 1) * meanPair) / uniqueMembers.length;
      const diversificationMultiplier = Math.sqrt(Math.max(varianceRatio, 0));
      if (diversificationMultiplier <= 0) {
        return [];
      }
      const recommendedTotalWeight = Math.max(
        0,
        Math.min(1, effectiveSleeveCap / diversificationMultiplier),
      );
      const correlationBasis =
        tailMeanPairCorrelation != null && tailMeanPairCorrelation >= normalMeanPairCorrelation
          ? "tail_raw"
          : "normal";
      return [
        {
          marker,
          members: uniqueMembers,
          memberCount: uniqueMembers.length,
          meanPairCorrelation: meanPair,
          normalMeanPairCorrelation,
          tailMeanPairCorrelation,
          correlationBasis,
          effectiveSleeveCap,
          diversificationMultiplier,
          recommendedTotalWeight,
          recommendedMemberWeightEqual: recommendedTotalWeight / uniqueMembers.length,
        },
      ];
    });
}
