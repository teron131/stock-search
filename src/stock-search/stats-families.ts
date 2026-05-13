/** Shared stat-family groupings and cache windows for the TypeScript resolver. */

export type StatsFamily =
	| "market_data"
	| "market_snapshot"
	| "statistics"
	| "financials"
	| "ratings";

export const STAT_FAMILIES: StatsFamily[] = [
	"market_data",
	"market_snapshot",
	"statistics",
	"financials",
	"ratings",
];

export const FAMILY_FIELDS: Record<StatsFamily, string[]> = {
	market_data: ["price", "change", "change_percent_1d"],
	market_snapshot: [
		"name",
		"quote_type",
		"sector_name",
		"industry_name",
		"iv",
		"change_percent_1m",
		"change_percent_3m",
		"change_percent_6m",
		"change_percent_1y",
	],
	statistics: [
		"market_cap",
		"fx",
		"revenue",
		"pe",
		"pe_forward",
		"ps",
		"ps_forward",
		"peg",
		"beta",
		"roe",
		"roic",
		"debt_to_equity",
		"free_cash_flow",
		"shareholder_yield",
		"rsi",
	],
	financials: [
		"revenue",
		"revenue_growth",
		"revenue_growth_1y",
		"revenue_cagr_3y",
		"eps_growth",
		"fcf_growth_1y",
		"fcf_cagr_3y",
		"gross_margin",
		"gross_margin_median_3y",
		"operating_margin",
		"operating_margin_median_3y",
		"operating_margin_delta_vs_3y",
		"operating_margin_std_3y",
		"free_cash_flow",
		"fcf_margin_median_3y",
		"shares_change_1y",
		"shares_change_cagr_3y",
		"financials_currency",
		"research_and_development",
		"rd_intensity",
		"rd_knowledge_capital",
	],
	ratings: ["median_upside", "ratings"],
};

export const FAMILY_TIMESTAMP_FIELD: Record<StatsFamily, string> = {
	market_data: "market_data_fetched_at",
	market_snapshot: "market_snapshot_fetched_at",
	statistics: "statistics_fetched_at",
	financials: "financials_fetched_at",
	ratings: "ratings_fetched_at",
};

export const BLOCKING_AUTO_FAMILIES = new Set<StatsFamily>(["market_data"]);

export const FAMILY_POLICIES: Record<
	StatsFamily,
	{ freshWindowMs: number; staleWindowMs: number; failureCooldownMs: number }
> = {
	market_data: {
		freshWindowMs: 60_000,
		staleWindowMs: 600_000,
		failureCooldownMs: 180_000,
	},
	market_snapshot: {
		freshWindowMs: 3_600_000,
		staleWindowMs: 172_800_000,
		failureCooldownMs: 1_800_000,
	},
	statistics: {
		freshWindowMs: 86_400_000,
		staleWindowMs: 172_800_000,
		failureCooldownMs: 1_800_000,
	},
	financials: {
		freshWindowMs: 86_400_000,
		staleWindowMs: 172_800_000,
		failureCooldownMs: 1_800_000,
	},
	ratings: {
		freshWindowMs: 86_400_000,
		staleWindowMs: 172_800_000,
		failureCooldownMs: 1_800_000,
	},
};
