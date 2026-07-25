/** Owns runtime constants that are shared outside narrower policy modules. */

import { appConfig } from "./api/config.js";

export const CacheConfig = {
  HISTORY_TTL_SECONDS: 60,
  HISTORY_STALE_SECONDS: 600,
  HISTORY_FAILURE_COOLDOWN_SECONDS: 180,
  INFO_TTL_SECONDS: 3600,
  INFO_STALE_SECONDS: 172800,
  INFO_FAILURE_COOLDOWN_SECONDS: 1800,
  LIVE_STATS_MIN_REQUEST_GAP_SECONDS: 0,
} as const;

export const PortfolioConfig = {
  TARGET_TOTAL_EQUITY: 1_000_000,
  MAX_POSITION_QTY: 500,
  MAX_WORKERS: 8,
} as const;

export const UpdateTierLabels = {
  FAST_LABEL: "history_1m",
  SLOW_LABEL: "info_1h",
  RATINGS_LABEL: "ratings_1d",
  EVAL_LABEL: "llm_optional",
  ETF_HOLDINGS_LABEL: "llm_optional",
} as const;

export const ModelConfig = {
  qualityOrFast(): string {
    const modelName = process.env.QUALITY_LLM || process.env.FAST_LLM;
    if (!modelName) {
      throw new Error("No model configured. Set QUALITY_LLM or FAST_LLM.");
    }
    return modelName;
  },
} as const;

export const DATA_SQLITE_PATH = appConfig.dataSqlitePath;
export const RAW_UI_DIR = appConfig.rawUiDir;
