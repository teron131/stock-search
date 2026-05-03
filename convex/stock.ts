import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";

type GenericRow = Record<string, unknown>;
type StockDocument = Doc<"stocks">;
type StoredStockFamilies = Pick<
	StockDocument,
	"indicators" | "evaluation" | "labels"
>;
type StockPayload = {
	ticker: string;
	indicators: GenericRow;
	evaluation: GenericRow;
	labels: string[];
	updatedAt: number;
};
type NormalizedStockEntry = GenericRow & { ticker: string };
type StockWrite =
	| { kind: "skip" }
	| { kind: "insert"; payload: StockPayload }
	| { kind: "patch"; id: Id<"stocks">; payload: StockPayload };
const ETF_MARKET_CAP_FIELDS = ["market_cap", "fx"] as const;

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

function normalizeIndicators(value: unknown): GenericRow {
	const indicators = { ...normalizeObject(value) };
	const quoteType = String(
		indicators.quote_type ?? indicators.equity_type ?? "",
	)
		.trim()
		.toUpperCase();
	if (quoteType === "ETF") {
		for (const field of ETF_MARKET_CAP_FIELDS) {
			indicators[field] = null;
		}
	}
	return indicators;
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

function normalizeStockEntry(value: unknown): GenericRow | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	return value as GenericRow;
}

function buildStockPayload(
	entry: GenericRow,
	{
		existing,
		now,
	}: {
		existing?: StoredStockFamilies | null;
		now: number;
	},
): StockPayload {
	return {
		ticker: normalizeTicker(entry.ticker),
		indicators:
			entry.indicators === undefined
				? normalizeIndicators(existing?.indicators)
				: normalizeIndicators(entry.indicators),
		evaluation:
			entry.evaluation === undefined
				? normalizeObject(existing?.evaluation)
				: normalizeObject(entry.evaluation),
		labels:
			entry.labels === undefined
				? normalizeLabels(existing?.labels)
				: normalizeLabels(entry.labels),
		updatedAt: now,
	};
}

function stockPayloadChanged(
	existing: StoredStockFamilies,
	payload: StockPayload,
): boolean {
	return (
		JSON.stringify(normalizeObject(existing.indicators)) !==
			JSON.stringify(payload.indicators) ||
		JSON.stringify(normalizeObject(existing.evaluation)) !==
			JSON.stringify(payload.evaluation) ||
		JSON.stringify(normalizeLabels(existing.labels)) !==
			JSON.stringify(payload.labels)
	);
}

function buildStockWrite(
	existing: StockDocument | null | undefined,
	payload: StockPayload,
): StockWrite {
	if (!existing) {
		return { kind: "insert", payload };
	}

	if (!stockPayloadChanged(existing, payload)) {
		return { kind: "skip" };
	}

	return { kind: "patch", id: existing._id, payload };
}

function buildExistingStocksByTicker(rows: StockDocument[]) {
	return new Map(rows.map((row) => [row.ticker, row]));
}

async function loadExistingStocksByTicker(
	ctx: MutationCtx,
	tickers: string[],
): Promise<Map<string, StockDocument>> {
	if (tickers.length === 0) {
		return new Map();
	}

	const rows = await Promise.all(
		tickers.map((ticker) =>
			ctx.db
				.query("stocks")
				.withIndex("by_ticker", (q) => q.eq("ticker", ticker))
				.unique(),
		),
	);

	return buildExistingStocksByTicker(
		rows.filter((row): row is StockDocument => row !== null),
	);
}

function normalizeStockEntries(rows: unknown): NormalizedStockEntry[] {
	if (!Array.isArray(rows)) {
		return [];
	}

	const normalizedByTicker = new Map<string, NormalizedStockEntry>();
	for (const row of rows) {
		const entry = normalizeStockEntry(row);
		if (!entry) {
			continue;
		}
		const ticker = normalizeTicker(entry.ticker);
		if (!ticker) {
			continue;
		}
		normalizedByTicker.set(ticker, { ...entry, ticker });
	}
	return Array.from(normalizedByTicker.values());
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
		indicators: normalizeIndicators(row.indicators),
		evaluation: normalizeObject(row.evaluation),
		labels: normalizeLabels(row.labels),
		updatedAt: row.updatedAt,
	};
}

export const list = query({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query("stocks").collect();
		return rows
			.map(toStockPayload)
			.sort((a, b) => a.ticker.localeCompare(b.ticker));
	},
});

export const lastUpdatedAt = query({
	args: {},
	handler: async (ctx) => {
		const row = await ctx.db
			.query("stocks")
			.withIndex("by_updated_at")
			.order("desc")
			.first();
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
		const ticker = normalizeTicker(args.ticker);
		if (!ticker) {
			return { ok: false, updated: false };
		}

		const now = Date.now();
		const existing = await ctx.db
			.query("stocks")
			.withIndex("by_ticker", (q) => q.eq("ticker", ticker))
			.unique();

		const payload = buildStockPayload(
			{
				ticker,
				indicators: args.indicators,
				evaluation: args.evaluation,
				labels: args.labels,
			},
			{ existing, now },
		);

		const write = buildStockWrite(existing, payload);
		if (write.kind === "patch") {
			await ctx.db.patch(write.id, write.payload);
		}
		if (write.kind !== "insert") {
			return { ok: true, updated: true };
		}

		await ctx.db.insert("stocks", write.payload);
		return { ok: true, updated: false };
	},
});

export const upsertMany = mutation({
	args: { rows: v.array(v.any()) },
	handler: async (ctx, args) => {
		const now = Date.now();
		const normalizedEntries = normalizeStockEntries(args.rows);
		if (normalizedEntries.length === 0) {
			return { ok: true, count: 0 };
		}

		const existingByTicker = await loadExistingStocksByTicker(
			ctx,
			normalizedEntries.map((entry) => entry.ticker),
		);

		for (const entry of normalizedEntries) {
			const ticker = normalizeTicker(entry.ticker);
			const existing = existingByTicker.get(ticker);
			const payload = buildStockPayload(entry, { existing, now });
			const write = buildStockWrite(existing, payload);

			if (write.kind === "patch") {
				await ctx.db.patch(write.id, write.payload);
			}
			if (write.kind === "insert") {
				await ctx.db.insert("stocks", write.payload);
			}
		}

		return { ok: true, count: normalizedEntries.length };
	},
});

export const deleteByTickers = mutation({
	args: { tickers: v.array(v.string()) },
	handler: async (ctx, args) => {
		const tickers = normalizeTickers(args.tickers);
		if (tickers.length === 0) {
			return { ok: true, count: 0 };
		}

		const rows = await loadExistingStocksByTicker(ctx, tickers);
		for (const ticker of tickers) {
			const row = rows.get(ticker);
			if (row) {
				await ctx.db.delete(row._id);
			}
		}

		return { ok: true, count: tickers.length };
	},
});

export const replaceAll = mutation({
	args: { rows: v.array(v.any()) },
	handler: async (ctx, args) => {
		const now = Date.now();
		const normalizedEntries = normalizeStockEntries(args.rows);
		const existingRows = await ctx.db.query("stocks").collect();
		const existingByTicker = buildExistingStocksByTicker(existingRows);
		const nextTickers = new Set<string>();

		for (const entry of normalizedEntries) {
			const ticker = normalizeTicker(entry.ticker);
			if (!ticker) {
				continue;
			}
			nextTickers.add(ticker);

			const existing = existingByTicker.get(ticker);
			const payload = buildStockPayload(entry, { existing: null, now });
			const write = buildStockWrite(existing, payload);

			if (write.kind === "patch") {
				await ctx.db.patch(write.id, write.payload);
			}
			if (write.kind === "insert") {
				await ctx.db.insert("stocks", write.payload);
			}
		}

		for (const row of existingRows) {
			if (!nextTickers.has(row.ticker)) {
				await ctx.db.delete(row._id);
			}
		}

		return { ok: true, count: normalizedEntries.length };
	},
});
