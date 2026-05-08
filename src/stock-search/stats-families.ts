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
		"rsi",
		"change_percent_1m",
		"change_percent_3m",
		"change_percent_6m",
		"change_percent_1y",
		"change_percent_mtd",
		"change_percent_ytd",
	],
	statistics: [
		"market_cap",
		"fx",
		"pe",
		"pe_forward",
		"peg",
		"beta",
		"roic",
		"free_cash_flow",
		"shareholder_yield",
	],
	financials: [
		"revenue_growth",
		"gross_margin",
		"operating_margin",
		"debt_to_equity",
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
