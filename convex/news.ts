import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { changedFields } from "./flat_diff";

type GenericRow = Record<string, unknown>;
type StoredNewsRow = {
	key: string;
	ticker: string;
	row: GenericRow;
	updatedAt: number;
};
type NewsDocument = Doc<"news">;
type NewsPayload = Omit<NewsDocument, "_creationTime" | "_id">;

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const NEWS_FETCH_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const NEWS_PUBLISHED_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const NEWS_ARRAY_KEYS = ["items", "articles", "news"] as const;

function isRecord(value: unknown): value is GenericRow {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNewsTimestamp(value: unknown): number | null {
	if (typeof value !== "string" || !value.trim()) {
		return null;
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function isExpiredTimestamp(
	timestamp: number | null,
	maxAgeMs: number,
	now: number,
): boolean {
	return timestamp != null && now - timestamp > maxAgeMs;
}

function isRetainedNewsItem(value: unknown, now: number): boolean {
	if (!isRecord(value)) {
		return false;
	}

	const metadata = isRecord(value.metadata) ? value.metadata : null;
	const fetchedTimestamp =
		parseNewsTimestamp(metadata?.fetched_at) ??
		parseNewsTimestamp(value.fetched_at);
	const publishedTimestamp =
		parseNewsTimestamp(metadata?.published_at) ??
		parseNewsTimestamp(value.published_at) ??
		parseNewsTimestamp(value.date);
	const daysAgo = Number(value.days_ago);
	const hasDaysAgo = Number.isFinite(daysAgo);

	if (isExpiredTimestamp(fetchedTimestamp, NEWS_FETCH_RETENTION_MS, now)) {
		return false;
	}

	if (
		isExpiredTimestamp(publishedTimestamp, NEWS_PUBLISHED_RETENTION_MS, now)
	) {
		return false;
	}

	if (
		publishedTimestamp == null &&
		hasDaysAgo &&
		daysAgo * DAY_IN_MS > NEWS_PUBLISHED_RETENTION_MS
	) {
		return false;
	}

	return fetchedTimestamp != null || publishedTimestamp != null || hasDaysAgo;
}

function pruneArrayItems(values: unknown[], now: number): unknown[] {
	return values
		.map((item) => pruneNewsPayload(item, now))
		.filter((item) => item != null);
}

function pruneNewsPayload(value: unknown, now: number): unknown | null {
	if (Array.isArray(value)) {
		return pruneArrayItems(value, now);
	}
	if (!isRecord(value)) {
		return value;
	}

	const looksLikeArticle =
		"url" in value ||
		"title" in value ||
		"summary" in value ||
		"days_ago" in value ||
		"published_at" in value ||
		"metadata" in value;
	if (looksLikeArticle) {
		return isRetainedNewsItem(value, now) ? value : null;
	}

	const nextValue: GenericRow = { ...value };
	let prunedArrayCount = 0;
	let nonEmptyArrayCount = 0;

	for (const key of NEWS_ARRAY_KEYS) {
		if (!Array.isArray(nextValue[key])) {
			continue;
		}
		prunedArrayCount += 1;
		const prunedItems = pruneArrayItems(nextValue[key], now);
		nextValue[key] = prunedItems;
		if (prunedItems.length > 0) {
			nonEmptyArrayCount += 1;
		}
	}

	if (prunedArrayCount > 0 && nonEmptyArrayCount === 0) {
		return null;
	}

	return nextValue;
}

function normalizeNewsEntries(
	rows: unknown,
	key: string,
): Array<{
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

function optionalString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function optionalNumber(value: unknown): number | null {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function newsPayload(
	key: string,
	ticker: string,
	row: GenericRow,
	updatedAt: number,
): NewsPayload {
	const metadata = isRecord(row.metadata) ? row.metadata : {};
	return {
		key,
		ticker,
		url: typeof row.url === "string" ? row.url : "",
		title: optionalString(row.title),
		date: optionalString(row.date),
		days_ago: optionalNumber(row.days_ago),
		summary: typeof row.summary === "string" ? row.summary : "",
		relevancy: typeof row.relevancy === "string" ? row.relevancy : "low",
		category: typeof row.category === "string" ? row.category : "other",
		sentiment: typeof row.sentiment === "string" ? row.sentiment : "neutral",
		metadata_provider: optionalString(metadata.provider),
		metadata_source_domain: optionalString(metadata.source_domain),
		metadata_published_at: optionalString(metadata.published_at),
		metadata_fetched_at: optionalString(metadata.fetched_at),
		updatedAt,
	};
}

function newsRowFromDocument(row: NewsDocument): GenericRow {
	const metadata: GenericRow = {};
	for (const [key, value] of [
		["provider", row.metadata_provider],
		["source_domain", row.metadata_source_domain],
		["published_at", row.metadata_published_at],
		["fetched_at", row.metadata_fetched_at],
	] as const) {
		if (value !== undefined) {
			metadata[key] = value;
		}
	}
	return {
		url: row.url ?? "",
		title: row.title ?? null,
		date: row.date ?? null,
		days_ago: row.days_ago ?? null,
		summary: row.summary ?? "",
		relevancy: row.relevancy ?? "low",
		category: row.category ?? "other",
		sentiment: row.sentiment ?? "neutral",
		metadata,
	};
}

function normalizeTickers(tickers: unknown): string[] {
	if (!Array.isArray(tickers)) {
		return [];
	}

	return Array.from(
		new Set(
			tickers
				.map((ticker) =>
					typeof ticker === "string" ? ticker.toUpperCase().trim() : "",
				)
				.filter(Boolean),
		),
	);
}

export const list = query({
	args: { key: v.string() },
	handler: async (ctx, args) => {
		const key = args.key.trim() || "default";
		const now = Date.now();
		const rows = await ctx.db
			.query("news")
			.withIndex("by_key", (q) => q.eq("key", key))
			.collect();
		return rows
			.map((row) => {
				const prunedRow = pruneNewsPayload(newsRowFromDocument(row), now);
				if (!isRecord(prunedRow)) {
					return null;
				}
				return {
					key: row.key,
					ticker: row.ticker,
					row: prunedRow,
					updatedAt: row.updatedAt,
				};
			})
			.filter((row): row is StoredNewsRow => row !== null)
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
			const prunedRow = pruneNewsPayload(entry.row, now);
			if (!isRecord(prunedRow)) {
				continue;
			}
			nextTickers.add(entry.ticker);
			const existingRow = existingByTicker.get(entry.ticker);
			const payload = newsPayload(key, entry.ticker, prunedRow, now);
			if (existingRow) {
				const patch = changedFields(existingRow as GenericRow, payload);
				if (patch) {
					await ctx.db.patch(existingRow._id, patch);
				}
				continue;
			}

			await ctx.db.insert("news", payload);
		}

		for (const row of existing) {
			if (!nextTickers.has(row.ticker)) {
				await ctx.db.delete(row._id);
			}
		}
		return { ok: true, count: normalizedEntries.length };
	},
});

export const deleteByTickers = mutation({
	args: { tickers: v.array(v.string()), key: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const key = (args.key ?? "").trim() || "default";
		const tickers = normalizeTickers(args.tickers);
		if (tickers.length === 0) {
			return { ok: true, count: 0 };
		}

		for (const ticker of tickers) {
			const rows = await ctx.db
				.query("news")
				.withIndex("by_key_ticker", (q) =>
					q.eq("key", key).eq("ticker", ticker),
				)
				.collect();
			for (const row of rows) {
				await ctx.db.delete(row._id);
			}
		}

		return { ok: true, count: tickers.length };
	},
});
