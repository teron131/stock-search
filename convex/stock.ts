import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

type GenericRow = Record<string, unknown>;

function normalizeTicker(value: unknown): string {
	return typeof value === "string" ? value.toUpperCase().trim() : "";
}

function normalizeLabels(labels: unknown): string[] {
	if (!Array.isArray(labels)) {
		return [];
	}
	return labels
		.map((label) => String(label || "").trim())
		.filter((label) => label.length > 0);
}

function normalizeObject(value: unknown): GenericRow {
	if (typeof value !== "object" || value === null) {
		return {};
	}
	return value as GenericRow;
}

function normalizeTickers(tickers: unknown): string[] {
	if (!Array.isArray(tickers)) {
		return [];
	}
	const normalized = tickers
		.map((ticker) => normalizeTicker(ticker))
		.filter((ticker) => ticker.length > 0);
	return Array.from(new Set(normalized));
}

function toStockPayload(row: {
	ticker: string;
	indicators?: unknown;
	evaluation?: unknown;
	labels?: unknown;
	updatedAt: number;
}) {
	return {
		ticker: row.ticker,
		indicators: normalizeObject(row.indicators),
		evaluation: normalizeObject(row.evaluation),
		labels: normalizeLabels(row.labels),
		updatedAt: row.updatedAt,
	};
}

export const list = query({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query("stocks").collect();
		return rows.map(toStockPayload).sort((a, b) => a.ticker.localeCompare(b.ticker));
	},
});

export const lastUpdatedAt = query({
	args: {},
	handler: async (ctx) => {
		const row = await ctx.db.query("stocks").withIndex("by_updated_at").order("desc").first();
		return row?.updatedAt ?? null;
	},
});

export const get = query({
	args: { ticker: v.string() },
	handler: async (ctx, args) => {
		const ticker = normalizeTicker(args.ticker);
		const row = await ctx.db
			.query("stocks")
			.withIndex("by_ticker", (q) => q.eq("ticker", ticker))
			.unique();
		if (!row) {
			return null;
		}
		return toStockPayload({ ...row, ticker });
	},
});

export const getMany = query({
	args: { tickers: v.array(v.string()) },
	handler: async (ctx, args) => {
		const normalizedTickers = normalizeTickers(args.tickers);
		if (normalizedTickers.length === 0) {
			return [];
		}

		const rows = await Promise.all(
			normalizedTickers.map((ticker) =>
				ctx.db
					.query("stocks")
					.withIndex("by_ticker", (q) => q.eq("ticker", ticker))
					.unique(),
			),
		);

		return rows
			.filter((row): row is NonNullable<(typeof rows)[number]> => row !== null)
			.map((row) => toStockPayload(row))
			.sort((a, b) => a.ticker.localeCompare(b.ticker));
	},
});

export const upsert = mutation({
	args: {
		ticker: v.string(),
		indicators: v.optional(v.any()),
		evaluation: v.optional(v.any()),
		labels: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args) => {
		const ticker = args.ticker.toUpperCase().trim();
		if (!ticker) {
			return { ok: false, updated: false };
		}

		const now = Date.now();
		const existing = await ctx.db
			.query("stocks")
			.withIndex("by_ticker", (q) => q.eq("ticker", ticker))
			.unique();

		const payload = {
			ticker,
			indicators:
				args.indicators === undefined
					? normalizeObject(existing?.indicators)
					: normalizeObject(args.indicators),
			evaluation:
				args.evaluation === undefined
					? normalizeObject(existing?.evaluation)
					: normalizeObject(args.evaluation),
			labels:
				args.labels === undefined
					? normalizeLabels(existing?.labels)
					: normalizeLabels(args.labels),
			updatedAt: now,
		};

		if (existing) {
			await ctx.db.patch(existing._id, payload);
			return { ok: true, updated: true };
		}

		await ctx.db.insert("stocks", payload);
		return { ok: true, updated: false };
	},
});

export const upsertMany = mutation({
	args: { rows: v.array(v.any()) },
	handler: async (ctx, args) => {
		const now = Date.now();
		let count = 0;

		for (const entry of args.rows) {
			if (!entry || typeof entry !== "object") {
				continue;
			}

			const ticker = normalizeTicker((entry as GenericRow).ticker);
			if (!ticker) {
				continue;
			}

			const existing = await ctx.db
				.query("stocks")
				.withIndex("by_ticker", (q) => q.eq("ticker", ticker))
				.unique();

			const payload = {
				ticker,
				indicators:
					(entry as GenericRow).indicators === undefined
						? normalizeObject(existing?.indicators)
						: normalizeObject((entry as GenericRow).indicators),
				evaluation:
					(entry as GenericRow).evaluation === undefined
						? normalizeObject(existing?.evaluation)
						: normalizeObject((entry as GenericRow).evaluation),
				labels:
					(entry as GenericRow).labels === undefined
						? normalizeLabels(existing?.labels)
						: normalizeLabels((entry as GenericRow).labels),
				updatedAt: now,
			};

			if (existing) {
				await ctx.db.patch(existing._id, payload);
			} else {
				await ctx.db.insert("stocks", payload);
			}
			count += 1;
		}

		return { ok: true, count };
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
				indicators: normalizeObject((entry as GenericRow).indicators),
				evaluation: normalizeObject((entry as GenericRow).evaluation),
				labels: normalizeLabels((entry as GenericRow).labels),
				updatedAt: now,
			});
		}

		return { ok: true, count: args.rows.length };
	},
});
