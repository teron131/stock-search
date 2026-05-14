/** Shared portfolio constants and small normalization helpers. */

import type { PositionRow } from "../api/data-store.js";
import { uniqueTickers } from "../utils.js";

export type PortfolioScope =
	| "priority"
	| "all_cached"
	| "portfolio_live"
	| "all";

export const LIVE_SCOPES = new Set<PortfolioScope>(["portfolio_live", "all"]);
export const ALL_UNIVERSE_SCOPES = new Set<PortfolioScope>([
	"all_cached",
	"all",
]);
export const LABEL_REFRESH_SCOPES = new Set<PortfolioScope>(["all"]);
export const PORTFOLIO_LABEL_FIELD = "industry_labels";
export const LABEL_FETCHED_AT_FIELD = "industry_labels_fetched_at";
export const LABEL_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const EVAL_KEYS = [
	"overall_score",
	"quality_score",
	"llm_quality_score",
	"valuation_score",
	"moat_score",
	"upside_score",
	"bull_probability",
	"bear_probability",
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
