import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("positions").collect();
    return rows
      .map((row) => ({
        ticker: row.ticker,
        quantity: row.quantity,
        strategy: row.strategy ?? null,
        labels: Array.isArray(row.labels) ? row.labels : [],
      }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
  },
});

export const replaceAll = mutation({
  args: {
    positions: v.array(
      v.object({
        ticker: v.string(),
        quantity: v.number(),
        strategy: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db.query("positions").collect();
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }

    for (const row of args.positions) {
      const ticker = row.ticker.toUpperCase().trim();
      if (!ticker) {
        continue;
      }
      await ctx.db.insert("positions", {
        ticker,
        quantity: Number(row.quantity) || 0,
        strategy: row.strategy ?? undefined,
        labels: [],
        updatedAt: now,
      });
    }
    return { ok: true, count: args.positions.length };
  },
});
