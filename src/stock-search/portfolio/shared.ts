/** Owns portfolio row field names and label normalization shared across row builders. */

import type { PositionRow } from "../storage/index.js";
import { uniqueTickers } from "../utils.js";

export const PORTFOLIO_LABEL_FIELD = "industry_labels";
export const POSITION_SOURCE_FIELD = "position_source";
export const POSITION_SOURCE_DASHBOARD_MANUAL = "dashboard_manual";
export const POSITION_SOURCE_DASHBOARD_WATCHLIST = "dashboard_watchlist";
export const POSITION_SOURCE_ETF_PROXY = "etf_proxy";
export const POSITION_SOURCE_IMAGE_IMPORT = "image_import";
export const POSITION_SOURCE_IMAGE_IMPORT_ABSENT = "image_import_absent";
export const POSITION_SOURCE_CACHED_UNIVERSE = "cached_universe";
export const LABEL_FETCHED_AT_FIELD = "industry_labels_fetched_at";
export const LABEL_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const EVAL_KEYS = [
	"overall_score",
	"quality_score",
	"llm_quality_score",
	"valuation_score",
	"moat_score",
	"upside_score",
	"market_cap_score",
	"tactical_score",
] as const;
export const STAT_DERIVED_EVAL_KEYS = new Set<(typeof EVAL_KEYS)[number]>([
	"overall_score",
	"quality_score",
	"valuation_score",
	"moat_score",
	"upside_score",
	"market_cap_score",
	"tactical_score",
]);
export function normalizeLabels(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return [
		...new Set(
			value.map((label) => String(label ?? "").trim()).filter(Boolean),
		),
	];
}

export function portfolioTickers(positions: PositionRow[]): string[] {
	return uniqueTickers(positions.map((position) => position.ticker));
}
