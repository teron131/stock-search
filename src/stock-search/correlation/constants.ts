/** Centralizes correlation model defaults, windows, and numerical tolerances. */

import type { HorizonConfig, LookbackConfig } from "./types.js";

export const HISTORY_RANGE = "5y";
export const HISTORY_INTERVAL = "1d";
export const TRADING_DAYS_PER_YEAR = 252;
export const MIN_RESIDUAL_OBSERVATIONS = 30;
export const ATANH_EPSILON = 1e-6;
export const MAX_FETCH_WORKERS = 12;
export const MARKET_PROXY_TICKER = "SPY";
export const PSD_EIGENVALUE_FLOOR = 1e-8;
export const PSD_SHRINKAGE = 0.05;
export const DEFAULT_EFFECTIVE_SLEEVE_CAP = 0.15;
export const EIGEN_TOLERANCE = 1e-12;
export const DATE_COLUMN = "date";

export const DEFAULT_CORRELATION_TICKERS: string[] = [];

export const HORIZONS: readonly HorizonConfig[] = [
  { name: "daily", intentWeight: 1.0, minObservations: 60 },
  { name: "weekly", intentWeight: 3.0, minObservations: 26 },
  { name: "monthly", intentWeight: 2.0, minObservations: 12 },
] as const;

export const LOOKBACKS: readonly LookbackConfig[] = [
  { years: 1, intentWeight: 3.0 },
  { years: 3, intentWeight: 2.0 },
  { years: 5, intentWeight: 1.0 },
] as const;
