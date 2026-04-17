import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

type GenericRow = Record<string, unknown>;

function normalizeNewsEntries(rows: unknown, key: string): Array<{
	ticker: string;
	row: GenericRow;
}> {
	if (!Array.isArray(rows)) {
		return [];
	}

	const normalizedByTicker = new Map<string, GenericRow>();
	for (const value of rows) {
		if (!value || typeof value !== "object") {
			continue;
		}
		const entry = value as GenericRow;
		const tickerRaw = entry.ticker;
		const ticker =
			typeof tickerRaw === "string" ? tickerRaw.toUpperCase().trim() : "";
		if (!ticker) {
			continue;
		}
		const row = { ...entry };
		delete row.ticker;
		delete row.key;
		normalizedByTicker.set(ticker, row);
	}

	return Array.from(normalizedByTicker.entries()).map(([ticker, row]) => ({
		key,
		ticker,
		row,
	}));
}

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
		const existingByTicker = new Map(existing.map((row) => [row.ticker, row]));
		const normalizedEntries = normalizeNewsEntries(args.rows, key);
		const nextTickers = new Set<string>();

		for (const entry of normalizedEntries) {
			nextTickers.add(entry.ticker);
			const existingRow = existingByTicker.get(entry.ticker);
			if (existingRow) {
				if (JSON.stringify(existingRow.row) !== JSON.stringify(entry.row)) {
					await ctx.db.patch(existingRow._id, {
						row: entry.row,
						updatedAt: now,
					});
				}
				continue;
			}

			await ctx.db.insert("news", {
				key,
				ticker: entry.ticker,
				row: entry.row,
				updatedAt: now,
			});
		}

		for (const row of existing) {
			if (!nextTickers.has(row.ticker)) {
				await ctx.db.delete(row._id);
			}
		}
		return { ok: true, count: normalizedEntries.length };
	},
});
