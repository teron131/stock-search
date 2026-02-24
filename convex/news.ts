import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

type GenericRow = Record<string, unknown>;

export const list = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const key = args.key.trim() || "default";
    const rows = await ctx.db
      .query("news")
      .withIndex("by_key", (q) => q.eq("key", key))
      .collect();
    return rows
      .map((row) => ({
        key: row.key,
        ticker: row.ticker,
        row:
          typeof row.row === "object" && row.row !== null
            ? (row.row as GenericRow)
            : {},
        updatedAt: row.updatedAt,
      }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
  },
});

export const replaceAll = mutation({
  args: { key: v.string(), rows: v.array(v.any()) },
  handler: async (ctx, args) => {
    const key = args.key.trim() || "default";
    const now = Date.now();
    const existing = await ctx.db
      .query("news")
      .withIndex("by_key", (q) => q.eq("key", key))
      .collect();
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
      delete row.key;
      await ctx.db.insert("news", {
        key,
        ticker,
        row,
        updatedAt: now,
      });
    }
    return { ok: true, count: args.rows.length };
  },
});
