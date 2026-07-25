/** Defines the correlation report contracts shared by API, CLI, and tests. */

import type { DataFrame } from "nodejs-polars";

export type BlendWeightMode = "reliability" | "intent" | "hybrid";
export type CorrelationMode = "raw" | "market_neutral";

export type HorizonConfig = {
  name: "daily" | "weekly" | "monthly";
  intentWeight: number;
  minObservations: number;
};

export type LookbackConfig = {
  years: number;
  intentWeight: number;
};

export type ClosePoint = {
  date: Date;
  close: number;
};

export type CloseHistory = {
  ticker: string;
  name: string;
  points: ClosePoint[];
};

export type TimeSeriesFrame = DataFrame;

export type TimeSeriesRow = {
  date: Date;
  values: Map<string, number>;
};

export type CorrelationInput = {
  name: string;
  correlationValues: number[][];
  pairCountValues: number[][];
  intentWeight: number;
  minObservations: number;
};

export type CorrelationMatrix = {
  tickers: string[];
  values: Array<Array<number | null>>;
};

export type TickerCorrelationStats = {
  name: string;
  ticker: string;
  annualizedReturn: number | null;
  dailyStdDev: number | null;
  monthlyStdDev: number | null;
  annualizedStdDev: number | null;
};

export type SleeveWeightRecommendation = {
  marker: string;
  members: string[];
  memberCount: number;
  meanPairCorrelation: number;
  normalMeanPairCorrelation: number;
  tailMeanPairCorrelation: number | null;
  correlationBasis: "normal" | "tail_raw";
  effectiveSleeveCap: number;
  diversificationMultiplier: number;
  recommendedTotalWeight: number;
  recommendedMemberWeightEqual: number;
};

export type CorrelationDiagnostics = {
  components: Record<
    string,
    {
      rows: number;
      horizonIntentWeight: number;
      lookbackIntentWeight: number;
      combinedIntentWeight: number;
      minObservations: number;
    }
  >;
  blendWeightMode: BlendWeightMode;
  correlationMode: CorrelationMode;
  matrixShrinkage: number;
  matrixMinEigenvalueRaw: number;
  matrixMinEigenvalueShrunk: number;
  matrixMinEigenvaluePsd: number;
  tail?: CorrelationDiagnostics;
  marketBetas?: Record<string, number>;
};

export type CorrelationReport = {
  tickers: string[];
  normalMatrixRaw: CorrelationMatrix;
  normalMatrixPsd: CorrelationMatrix;
  normalMatrixRounded: CorrelationMatrix;
  tailMatrixPsd: CorrelationMatrix;
  tailMatrixRaw: CorrelationMatrix;
  sleeveWeightRecommendations: SleeveWeightRecommendation[];
  stats: TickerCorrelationStats[];
  statsPercent: Array<
    Omit<
      TickerCorrelationStats,
      "annualizedReturn" | "dailyStdDev" | "monthlyStdDev" | "annualizedStdDev"
    > & {
      annualizedReturn: string;
      dailyStdDev: string;
      monthlyStdDev: string;
      annualizedStdDev: string;
    }
  >;
  diagnostics: CorrelationDiagnostics;
};

export type CorrelationReportOptions = {
  tickers?: string[];
  blendWeightMode?: BlendWeightMode;
  correlationMode?: CorrelationMode;
  marketProxyTicker?: string;
  effectiveSleeveCap?: number;
  historyFetcher?: (ticker: string) => Promise<CloseHistory>;
  tickerMarkers?: Record<string, string[]>;
};

export type YahooChartResponse = {
  chart?: {
    result?: Array<{
      meta?: {
        shortName?: string;
        longName?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: Array<number | null>;
        }>;
        adjclose?: Array<{
          adjclose?: Array<number | null>;
        }>;
      };
    }>;
  };
};
