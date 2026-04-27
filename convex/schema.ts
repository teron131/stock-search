import { defineSchema, defineTable } from "convex/server";
import { type Infer, v } from "convex/values";

export const PortfolioPositionSchema = v.object({
	ticker: v.string(),
	quantity: v.number(),
	strategy: v.optional(v.string()),
});
export type PortfolioPosition = Infer<typeof PortfolioPositionSchema>;

const NullableNumberSchema = v.union(v.number(), v.null());

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
		indicators: v.optional(v.any()),
		evaluation: v.optional(v.any()),
		labels: v.optional(v.array(v.string())),
		updatedAt: v.number(),
	})
		.index("by_ticker", ["ticker"])
		.index("by_updated_at", ["updatedAt"]),
	portfolios: defineTable({
		key: v.string(),
		positions: v.array(PortfolioPositionSchema),
		portfolioStats: v.optional(v.any()),
		updatedAt: v.number(),
	})
		.index("by_key", ["key"])
		.index("by_updated_at", ["updatedAt"]),
	news: defineTable({
		key: v.string(),
		ticker: v.string(),
		row: v.any(),
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
		sectors: v.array(SectorSummarySchema),
		meta: SectorSnapshotMetaSchema,
		updatedAt: v.number(),
	})
		.index("by_key", ["key"])
		.index("by_updated_at", ["updatedAt"]),
});
