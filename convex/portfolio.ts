import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

type GenericRow = Record<string, unknown>;

function normalizePositions(
  positions: unknown,
): Array<{ ticker: string; quantity: number }> {
  if (!Array.isArray(positions)) {
    return [];
  }
  const normalized: Array<{ ticker: string; quantity: number }> = [];
  for (const item of positions) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const tickerRaw = (item as GenericRow).ticker;
    const ticker =
      typeof tickerRaw === "string" ? tickerRaw.toUpperCase().trim() : "";
    if (!ticker) {
      continue;
    }
    const quantityRaw = Number((item as GenericRow).quantity);
    normalized.push({
      ticker,
      quantity: Number.isFinite(quantityRaw) ? quantityRaw : 0,
    });
  }
  return normalized;
}

export const get = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const key = args.key.trim() || "default";
    const row = await ctx.db
      .query("portfolios")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!row) {
      return null;
    }
    return {
      key: row.key,
      positions: normalizePositions(row.positions),
      portfolioStats:
        typeof row.portfolioStats === "object" && row.portfolioStats !== null
          ? (row.portfolioStats as GenericRow)
          : null,
      updatedAt: row.updatedAt,
    };
  },
});

export const set = mutation({
  args: {
    key: v.string(),
    positions: v.array(
      v.object({
        ticker: v.string(),
        quantity: v.number(),
      }),
    ),
    portfolioStats: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const key = args.key.trim() || "default";
    const now = Date.now();
    const existing = await ctx.db
      .query("portfolios")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    const payload = {
      key,
      positions: normalizePositions(args.positions),
      portfolioStats:
        typeof args.portfolioStats === "object" && args.portfolioStats !== null
          ? (args.portfolioStats as GenericRow)
          : undefined,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return { ok: true, updated: true };
    }
    await ctx.db.insert("portfolios", payload);
    return { ok: true, updated: false };
  },
});
