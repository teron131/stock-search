import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

type GenericRow = Record<string, unknown>;

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("evals").collect();
    return rows.map((row) => ({
      ticker: row.ticker,
      ...(typeof row.row === "object" && row.row !== null
        ? (row.row as GenericRow)
        : {}),
    }));
  },
});

export const getByTicker = query({
  args: { ticker: v.string() },
  handler: async (ctx, args) => {
    const ticker = args.ticker.toUpperCase().trim();
    const row = await ctx.db
      .query("evals")
      .withIndex("by_ticker", (q) => q.eq("ticker", ticker))
      .unique();
    if (!row) {
      return null;
    }
    return {
      ticker,
      ...(typeof row.row === "object" && row.row !== null
        ? (row.row as GenericRow)
        : {}),
    };
  },
});

export const replaceAll = mutation({
  args: { rows: v.array(v.any()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db.query("evals").collect();
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }

    for (const entry of args.rows) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const tickerRaw = (entry as GenericRow).ticker;
      const ticker =
        typeof tickerRaw === "string" ? tickerRaw.toUpperCase().trim() : "";
      if (!ticker) {
        continue;
      }
      const row = { ...(entry as GenericRow) };
      delete row.ticker;
      await ctx.db.insert("evals", {
        ticker,
        row,
        updatedAt: now,
      });
    }

    return { ok: true, count: args.rows.length };
  },
});
