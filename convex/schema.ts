import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  positions: defineTable({
    ticker: v.string(),
    quantity: v.number(),
    strategy: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    updatedAt: v.number(),
  })
    .index("by_ticker", ["ticker"])
    .index("by_updated_at", ["updatedAt"]),
  stats: defineTable({
    ticker: v.string(),
    row: v.any(),
    source: v.optional(v.string()),
    generatedAt: v.optional(v.number()),
    fundamentalsFetchedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_ticker", ["ticker"])
    .index("by_generated_at", ["generatedAt"])
    .index("by_fundamentals_fetched_at", ["fundamentalsFetchedAt"])
    .index("by_updated_at", ["updatedAt"]),
  evals: defineTable({
    ticker: v.string(),
    row: v.any(),
    updatedAt: v.number(),
  })
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
