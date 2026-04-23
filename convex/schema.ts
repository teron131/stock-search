import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
		positions: v.array(
			v.object({
				ticker: v.string(),
				quantity: v.number(),
				strategy: v.optional(v.string()),
			}),
		),
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
		.index("by_updated_at", ["updatedAt"]),
	meta_versions: defineTable({
		key: v.string(),
		value: v.string(),
		updatedAt: v.number(),
	})
		.index("by_key", ["key"])
		.index("by_updated_at", ["updatedAt"]),
});
