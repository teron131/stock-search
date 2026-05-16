import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { changedFields } from "./flat_diff";
import { type PortfolioPosition, PortfolioPositionSchema } from "./schema";

type GenericRow = Record<string, unknown>;
type PortfolioDocument = Doc<"portfolios">;
type PortfolioPayload = Omit<PortfolioDocument, "_creationTime" | "_id">;
type PortfolioStatsPayload = Pick<
	PortfolioPayload,
	| "change"
	| "change_percent"
	| "held_positions_count"
	| "total"
	| "weighted_beta"
	| "weighted_iv"
>;

const STATS_TICKER = "__STATS__";

function normalizeKey(value: string | undefined): string {
	return (value ?? "").trim() || "default";
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter(Boolean);
}

function numberOrZero(value: unknown): number {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}

function normalizePositions(positions: unknown): PortfolioPosition[] {
	if (!Array.isArray(positions)) {
		return [];
	}
	const normalized: PortfolioPosition[] = [];
	for (const item of positions) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const row = item as GenericRow;
		const ticker =
			typeof row.ticker === "string" ? row.ticker.toUpperCase().trim() : "";
		if (!ticker) {
			continue;
		}
		const strategy =
			typeof row.strategy === "string" && row.strategy.trim()
				? row.strategy.trim()
				: undefined;
		const position: PortfolioPosition = {
			ticker,
			quantity: numberOrZero(row.quantity),
		};
		if (strategy) {
			position.strategy = strategy;
		}
		const industryLabels = normalizeStringArray(row.industry_labels);
		if (industryLabels.length > 0) {
			position.industry_labels = industryLabels;
		}
		normalized.push(position);
	}
	return normalized;
}

function positionFromRow(row: PortfolioDocument): PortfolioPosition | null {
	if (!row.ticker || row.ticker === STATS_TICKER) {
		return null;
	}
	const position: PortfolioPosition = {
		ticker: row.ticker,
		quantity: numberOrZero(row.quantity),
	};
	if (row.strategy) {
		position.strategy = row.strategy;
	}
	const industryLabels = [
		row.industry_label_1,
		row.industry_label_2,
		row.industry_label_3,
	].filter((label): label is string => typeof label === "string" && !!label);
	if (industryLabels.length > 0) {
		position.industry_labels = industryLabels;
	}
	return position;
}

function portfolioStatsFromRow(
	row: PortfolioDocument | undefined,
): GenericRow | null {
	if (!row) {
		return null;
	}
	const stats: GenericRow = {};
	for (const field of [
		"total",
		"change",
		"change_percent",
		"held_positions_count",
		"weighted_beta",
		"weighted_iv",
	] as const) {
		if (row[field] !== undefined) {
			stats[field] = row[field];
		}
	}
	return Object.keys(stats).length > 0 ? stats : null;
}

function portfolioStatsPayload(value: unknown): PortfolioStatsPayload {
	const fallback = {
		total: null,
		change: null,
		change_percent: null,
		held_positions_count: null,
		weighted_beta: null,
		weighted_iv: null,
	};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return fallback;
	}
	const row = value as GenericRow;
	const payload: PortfolioStatsPayload = { ...fallback };
	for (const field of Object.keys(fallback) as Array<
		keyof PortfolioStatsPayload
	>) {
		const number = Number(row[field]);
		if (Number.isFinite(number)) {
			payload[field] = number;
		}
	}
	return payload;
}

function positionPayload(
	key: string,
	position: PortfolioPosition,
	sortIndex: number,
	now: number,
): PortfolioPayload {
	const labels = normalizeStringArray(position.industry_labels);
	return {
		key,
		ticker: position.ticker,
		sort_index: sortIndex,
		quantity: numberOrZero(position.quantity),
		strategy: position.strategy ?? null,
		industry_label_1: labels[0] ?? null,
		industry_label_2: labels[1] ?? null,
		industry_label_3: labels[2] ?? null,
		total: null,
		change: null,
		change_percent: null,
		held_positions_count: null,
		weighted_beta: null,
		weighted_iv: null,
		updatedAt: now,
	};
}

async function loadRows(ctx: { db: QueryDb }, key: string) {
	return ctx.db
		.query("portfolios")
		.withIndex("by_key", (q) => q.eq("key", key))
		.collect();
}

type QueryDb = QueryCtx["db"] | MutationCtx["db"];

async function replacePositions(
	ctx: MutationCtx,
	key: string,
	positions: PortfolioPosition[],
	now: number,
): Promise<void> {
	const rows = await loadRows(ctx, key);
	const existingByTicker = new Map(
		rows
			.filter((row) => row.ticker && row.ticker !== STATS_TICKER)
			.map((row) => [row.ticker, row]),
	);
	const nextTickers = new Set<string>();

	for (const [index, position] of positions.entries()) {
		nextTickers.add(position.ticker);
		const existing = existingByTicker.get(position.ticker);
		const payload = positionPayload(key, position, index, now);
		if (existing) {
			const patch = changedFields(existing as GenericRow, payload);
			if (patch) {
				await ctx.db.patch(existing._id, patch);
			}
		} else {
			await ctx.db.insert("portfolios", payload);
		}
	}

	for (const row of rows) {
		if (!row.ticker || row.ticker === STATS_TICKER) {
			if (!row.ticker) {
				await ctx.db.delete(row._id);
			}
			continue;
		}
		if (!nextTickers.has(row.ticker)) {
			await ctx.db.delete(row._id);
		}
	}
}

async function upsertPortfolioStats(
	ctx: MutationCtx,
	key: string,
	portfolioStats: unknown,
	now: number,
): Promise<void> {
	const payload = portfolioStatsPayload(portfolioStats);
	const rows = await loadRows(ctx, key);
	const existing = rows.find((row) => row.ticker === STATS_TICKER);
	if (Object.values(payload).every((value) => value == null)) {
		if (existing) {
			await ctx.db.delete(existing._id);
		}
		return;
	}
	const rowPayload: PortfolioPayload = {
		key,
		ticker: STATS_TICKER,
		sort_index: null,
		quantity: null,
		strategy: null,
		industry_label_1: null,
		industry_label_2: null,
		industry_label_3: null,
		total: null,
		change: null,
		change_percent: null,
		held_positions_count: null,
		weighted_beta: null,
		weighted_iv: null,
		updatedAt: now,
		...payload,
	};
	if (existing) {
		const patch = changedFields(existing as GenericRow, rowPayload);
		if (patch) {
			await ctx.db.patch(existing._id, patch);
		}
		return;
	}
	await ctx.db.insert("portfolios", rowPayload);
}

export const get = query({
	args: { key: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const key = normalizeKey(args.key);
		const rows = await loadRows(ctx, key);
		const positions = rows
			.map(positionFromRow)
			.filter((position): position is PortfolioPosition => position !== null);
		const statsRow = rows.find((row) => row.ticker === STATS_TICKER);
		return {
			key,
			positions,
			portfolioStats: portfolioStatsFromRow(statsRow),
			updatedAt: rows.reduce(
				(maxUpdatedAt, row) => Math.max(maxUpdatedAt, row.updatedAt ?? 0),
				0,
			),
		};
	},
});

export const getPositions = query({
	args: { key: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const key = normalizeKey(args.key);
		const rows = await loadRows(ctx, key);
		const positions = rows
			.map(positionFromRow)
			.filter((position): position is PortfolioPosition => position !== null);
		return positions;
	},
});

export const set = mutation({
	args: {
		key: v.string(),
		positions: v.array(PortfolioPositionSchema),
		portfolioStats: v.optional(v.any()),
	},
	handler: async (ctx, args) => {
		const key = normalizeKey(args.key);
		const now = Date.now();
		await replacePositions(ctx, key, normalizePositions(args.positions), now);
		if (args.portfolioStats !== undefined) {
			await upsertPortfolioStats(ctx, key, args.portfolioStats, now);
		}
		return { ok: true, updated: true };
	},
});

export const setPositions = mutation({
	args: {
		key: v.optional(v.string()),
		positions: v.array(PortfolioPositionSchema),
	},
	handler: async (ctx, args) => {
		await replacePositions(
			ctx,
			normalizeKey(args.key),
			normalizePositions(args.positions),
			Date.now(),
		);
		return { ok: true, updated: true };
	},
});
