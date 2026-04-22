/** Runtime configuration constants for the stock-search application.

This module consolidates configuration values that were previously scattered
across multiple files. Evaluation-specific constants remain in evaluation/constants.ts.
*/

import { appConfig } from "./api/config.js";

export class CacheConfig {
	/** Time-to-live for price/change history data (1 minute). */
	static readonly HISTORY_TTL_SECONDS = 60;

	/** Stale threshold for history data (10 minutes). */
	static readonly HISTORY_STALE_SECONDS = 600;

	/** Cooldown period after fetch failure (3 minutes). */
	static readonly HISTORY_FAILURE_COOLDOWN_SECONDS = 180;

	/** Time-to-live for fundamental info data (1 hour). */
	static readonly INFO_TTL_SECONDS = 3600;

	/** Stale threshold for fundamental data (48 hours). */
	static readonly INFO_STALE_SECONDS = 172800;

	/** Cooldown period after fundamental fetch failure (30 minutes). */
	static readonly INFO_FAILURE_COOLDOWN_SECONDS = 1800;

	/** Minimum gap between live stats requests (0 = no rate limiting). */
	static readonly LIVE_STATS_MIN_REQUEST_GAP_SECONDS = 0;
}

export class PortfolioConfig {
	/** Target total equity for sample portfolio generation. */
	static readonly TARGET_TOTAL_EQUITY = 1_000_000;

	/** Maximum quantity for a single position. */
	static readonly MAX_POSITION_QTY = 500;

	/** Maximum thread pool workers for parallel operations. */
	static readonly MAX_WORKERS = 8;
}

export class UpdateTierLabels {
	/** Label for fast-updating data (price, change). */
	static readonly FAST_LABEL = "history_1m";

	/** Label for slower-updating fundamental data. */
	static readonly SLOW_LABEL = "info_1h";

	/** Label for daily-updating analyst ratings. */
	static readonly RATINGS_LABEL = "ratings_1d";

	/** Label for optional LLM evaluations. */
	static readonly EVAL_LABEL = "llm_optional";

	/** Label for optional ETF holdings data. */
	static readonly ETF_HOLDINGS_LABEL = "llm_optional";
}

export class ModelConfig {
	/** Resolve QUALITY_LLM first, then FAST_LLM. */
	static qualityOrFast(): string {
		const modelName = process.env.QUALITY_LLM || process.env.FAST_LLM;
		if (!modelName) {
			throw new Error("No model configured. Set QUALITY_LLM or FAST_LLM.");
		}
		return modelName;
	}
}

export const DATA_SQLITE_PATH = appConfig.dataSqlitePath;
export const RAW_UI_DIR = appConfig.rawUiDir;
