import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

type GenericRow = Record<string, unknown>;

function normalizePositions(
	positions: unknown,
): Array<{ ticker: string; quantity: number; strategy?: string }> {
	if (!Array.isArray(positions)) {
		return [];
	}
	const normalized: Array<{ ticker: string; quantity: number; strategy?: string }> = [];
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
		const strategyRaw = (item as GenericRow).strategy;
		const strategy =
			typeof strategyRaw === "string" && strategyRaw.trim()
				? strategyRaw.trim()
				: undefined;
		const nextPosition: {
			ticker: string;
			quantity: number;
			strategy?: string;
		} = {
			ticker,
			quantity: Number.isFinite(quantityRaw) ? quantityRaw : 0,
		};
		if (strategy) {
			nextPosition.strategy = strategy;
		}
		normalized.push(nextPosition);
	}
	return normalized;
}

function normalizePortfolioStats(value: unknown): GenericRow | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	return value as GenericRow;
}

export const get = query({
	args: { key: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const key = (args.key ?? "").trim() || "default";
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

export const getPositions = query({
	args: { key: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const key = (args.key ?? "").trim() || "default";
		const row = await ctx.db
			.query("portfolios")
			.withIndex("by_key", (q) => q.eq("key", key))
			.unique();
		return row ? normalizePositions(row.positions) : [];
	},
});

export const set = mutation({
	args: {
		key: v.string(),
		positions: v.array(
			v.object({
				ticker: v.string(),
				quantity: v.number(),
				strategy: v.optional(v.string()),
			}),
		),
		portfolioStats: v.optional(v.any()),
	},
	handler: async (ctx, args) => {
		const key = args.key.trim() || "default";
		const now = Date.now();
		const normalizedPositions = normalizePositions(args.positions);
		const normalizedPortfolioStats = normalizePortfolioStats(args.portfolioStats);
		const existing = await ctx.db
			.query("portfolios")
			.withIndex("by_key", (q) => q.eq("key", key))
			.unique();
		const payload = {
			key,
			positions: normalizedPositions,
			portfolioStats: normalizedPortfolioStats ?? undefined,
			updatedAt: now,
		};
		if (existing) {
			const positionsUnchanged =
				JSON.stringify(normalizePositions(existing.positions)) ===
				JSON.stringify(normalizedPositions);
			const portfolioStatsUnchanged =
				JSON.stringify(normalizePortfolioStats(existing.portfolioStats)) ===
				JSON.stringify(normalizedPortfolioStats);
			if (!positionsUnchanged || !portfolioStatsUnchanged) {
				await ctx.db.patch(existing._id, payload);
			}
			return { ok: true, updated: true };
		}
		await ctx.db.insert("portfolios", payload);
		return { ok: true, updated: false };
	},
});

export const setPositions = mutation({
	args: {
		key: v.optional(v.string()),
		positions: v.array(
			v.object({
				ticker: v.string(),
				quantity: v.number(),
				strategy: v.optional(v.string()),
			}),
		),
	},
	handler: async (ctx, args) => {
		const key = (args.key ?? "").trim() || "default";
		const now = Date.now();
		const normalizedPositions = normalizePositions(args.positions);
		const existing = await ctx.db
			.query("portfolios")
			.withIndex("by_key", (q) => q.eq("key", key))
			.unique();

		if (!existing) {
			await ctx.db.insert("portfolios", {
				key,
				positions: normalizedPositions,
				updatedAt: now,
			});
			return { ok: true, updated: false };
		}

		if (
			JSON.stringify(normalizePositions(existing.positions)) ===
			JSON.stringify(normalizedPositions)
		) {
			return { ok: true, updated: true };
		}

		await ctx.db.patch(existing._id, {
			positions: normalizedPositions,
			updatedAt: now,
		});
		return { ok: true, updated: true };
	},
});
