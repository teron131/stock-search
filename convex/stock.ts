import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

type GenericRow = Record<string, unknown>;

function normalizeLabels(labels: unknown): string[] {
	if (!Array.isArray(labels)) {
		return [];
	}
	return labels
		.map((label) => String(label || "").trim())
		.filter((label) => label.length > 0);
}

export const list = query({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query("stocks").collect();
		return rows
			.map((row) => ({
				ticker: row.ticker,
				indicators:
					typeof row.indicators === "object" && row.indicators !== null
						? (row.indicators as GenericRow)
						: {},
				evaluation:
					typeof row.evaluation === "object" && row.evaluation !== null
						? (row.evaluation as GenericRow)
						: {},
				labels: normalizeLabels(row.labels),
				updatedAt: row.updatedAt,
			}))
			.sort((a, b) => a.ticker.localeCompare(b.ticker));
	},
});

export const get = query({
	args: { ticker: v.string() },
	handler: async (ctx, args) => {
		const ticker = args.ticker.toUpperCase().trim();
		const row = await ctx.db
			.query("stocks")
			.withIndex("by_ticker", (q) => q.eq("ticker", ticker))
			.unique();
		if (!row) {
			return null;
		}
		return {
			ticker,
			indicators:
				typeof row.indicators === "object" && row.indicators !== null
					? (row.indicators as GenericRow)
					: {},
			evaluation:
				typeof row.evaluation === "object" && row.evaluation !== null
					? (row.evaluation as GenericRow)
					: {},
			labels: normalizeLabels(row.labels),
			updatedAt: row.updatedAt,
		};
	},
});

export const replaceAll = mutation({
	args: { rows: v.array(v.any()) },
	handler: async (ctx, args) => {
		const now = Date.now();
		const existing = await ctx.db.query("stocks").collect();
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
			await ctx.db.insert("stocks", {
				ticker,
				indicators:
					typeof (entry as GenericRow).indicators === "object" &&
					(entry as GenericRow).indicators !== null
						? ((entry as GenericRow).indicators as GenericRow)
						: {},
				evaluation:
					typeof (entry as GenericRow).evaluation === "object" &&
					(entry as GenericRow).evaluation !== null
						? ((entry as GenericRow).evaluation as GenericRow)
						: {},
				labels: normalizeLabels((entry as GenericRow).labels),
				updatedAt: now,
			});
		}

		return { ok: true, count: args.rows.length };
	},
});
