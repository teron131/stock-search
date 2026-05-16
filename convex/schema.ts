import { defineSchema, defineTable } from "convex/server";
import { type Infer, v } from "convex/values";

export const PortfolioPositionSchema = v.object({
	ticker: v.string(),
	quantity: v.number(),
	strategy: v.optional(v.string()),
	position_source: v.optional(v.string()),
	industry_labels: v.optional(v.array(v.string())),
	extra: v.optional(v.any()),
});
export type PortfolioPosition = Infer<typeof PortfolioPositionSchema>;

const NullableNumberSchema = v.union(v.number(), v.null());
const NullableStringSchema = v.union(v.string(), v.null());

const StockFlatFieldSchemas = Object.fromEntries(
	[
		"name",
		"strategy",
		"quote_type",
		"equity_type",
		"fx",
		"sector_name",
		"industry_name",
		"earning_direction",
		"market_data_fetched_at",
		"market_snapshot_fetched_at",
		"statistics_fetched_at",
		"financials_fetched_at",
		"ratings_fetched_at",
		"industry_labels_fetched_at",
		"etf_holdings_fetched_at",
		"peg_source",
		"price",
		"change",
		"change_percent_1d",
		"change_percent_1m",
		"change_percent_3m",
		"change_percent_6m",
		"change_percent_1y",
		"change_percent_mtd",
		"change_percent_ytd",
		"fifty_day_change_percent",
		"one_hundred_day_change_percent",
		"two_hundred_day_change_percent",
		"market_cap",
		"pe",
		"pe_forward",
		"ps",
		"ps_forward",
		"peg",
		"beta",
		"iv",
		"rsi",
		"median_upside",
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
		"roe",
		"roic",
		"debt_to_equity",
		"free_cash_flow",
		"fcf_margin_median_3y",
		"shares_change_1y",
		"shares_change_cagr_3y",
		"shareholder_yield",
		"research_and_development",
		"rd_intensity",
		"rd_knowledge_capital",
		"overall_score",
		"quality_score",
		"valuation_score",
		"moat_score",
		"upside_score",
		"market_cap_score",
		"tactical_score",
		"future_score",
		"future_reasons",
		"moat_reasons",
		"quality_reasons",
		"upside_reasons",
		"industry_labels",
		"ratings",
		"etf_holdings",
		"etf_sectors",
	].map((field) => [field, v.optional(v.any())]),
);

export const SectorSummarySchema = v.object({
	sector: v.string(),
	top_tickers: v.array(v.string()),
	stock_count: v.number(),
	market_cap: NullableNumberSchema,
	pe: NullableNumberSchema,
	profit_margin: NullableNumberSchema,
	change_percent_1d: NullableNumberSchema,
	change_percent_1y: NullableNumberSchema,
});

export const SectorSnapshotMetaSchema = v.object({
	source: v.string(),
	fetched_at: v.union(v.string(), v.null()),
	sector_count: v.number(),
});

export default defineSchema({
	stocks: defineTable({
		ticker: v.string(),
		labels: v.optional(v.array(v.string())),
		updatedAt: v.number(),
		...StockFlatFieldSchemas,
	})
		.index("by_ticker", ["ticker"])
		.index("by_updated_at", ["updatedAt"]),
	portfolios: defineTable({
		key: v.string(),
		ticker: v.optional(NullableStringSchema),
		sort_index: v.optional(NullableNumberSchema),
		quantity: v.optional(NullableNumberSchema),
		strategy: v.optional(NullableStringSchema),
		position_source: v.optional(NullableStringSchema),
		industry_label_1: v.optional(NullableStringSchema),
		industry_label_2: v.optional(NullableStringSchema),
		industry_label_3: v.optional(NullableStringSchema),
		total: v.optional(NullableNumberSchema),
		change: v.optional(NullableNumberSchema),
		change_percent: v.optional(NullableNumberSchema),
		held_positions_count: v.optional(NullableNumberSchema),
		weighted_beta: v.optional(NullableNumberSchema),
		weighted_iv: v.optional(NullableNumberSchema),
		updatedAt: v.number(),
	})
		.index("by_key", ["key"])
		.index("by_key_ticker", ["key", "ticker"])
		.index("by_updated_at", ["updatedAt"]),
	news: defineTable({
		key: v.string(),
		ticker: v.string(),
		url: v.optional(v.string()),
		title: v.optional(v.union(v.string(), v.null())),
		date: v.optional(v.union(v.string(), v.null())),
		days_ago: v.optional(v.union(v.number(), v.null())),
		summary: v.optional(v.string()),
		relevancy: v.optional(v.string()),
		category: v.optional(v.string()),
		sentiment: v.optional(v.string()),
		metadata_provider: v.optional(v.union(v.string(), v.null())),
		metadata_source_domain: v.optional(v.union(v.string(), v.null())),
		metadata_published_at: v.optional(v.union(v.string(), v.null())),
		metadata_fetched_at: v.optional(v.union(v.string(), v.null())),
		updatedAt: v.number(),
	})
		.index("by_key", ["key"])
		.index("by_ticker", ["ticker"])
		.index("by_key_ticker", ["key", "ticker"])
		.index("by_updated_at", ["updatedAt"]),
	meta_versions: defineTable({
		key: v.string(),
		value: v.string(),
		updatedAt: v.number(),
	})
		.index("by_key", ["key"])
		.index("by_updated_at", ["updatedAt"]),
	sectors: defineTable({
		key: v.string(),
		sector: v.optional(NullableStringSchema),
		sort_index: v.optional(NullableNumberSchema),
		top_ticker_1: v.optional(NullableStringSchema),
		top_ticker_2: v.optional(NullableStringSchema),
		top_ticker_3: v.optional(NullableStringSchema),
		top_ticker_4: v.optional(NullableStringSchema),
		top_ticker_5: v.optional(NullableStringSchema),
		stock_count: v.optional(NullableNumberSchema),
		market_cap: v.optional(NullableNumberSchema),
		pe: v.optional(NullableNumberSchema),
		profit_margin: v.optional(NullableNumberSchema),
		change_percent_1d: v.optional(NullableNumberSchema),
		change_percent_1y: v.optional(NullableNumberSchema),
		meta_source: v.optional(NullableStringSchema),
		meta_fetched_at: v.optional(NullableStringSchema),
		meta_sector_count: v.optional(NullableNumberSchema),
		updatedAt: v.number(),
	})
		.index("by_key", ["key"])
		.index("by_key_sector", ["key", "sector"])
		.index("by_updated_at", ["updatedAt"]),
});
