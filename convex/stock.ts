import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { changedFields } from "./flat_diff";

type GenericRow = Record<string, unknown>;
type StockDocument = Doc<"stocks">;
type StockPayload = GenericRow & {
	ticker: string;
	labels: string[];
	updatedAt: number;
};
type NormalizedStockEntry = GenericRow & { ticker: string };
type StockWrite =
	| { kind: "skip" }
	| { kind: "insert"; payload: StockPayload }
	| { kind: "patch"; id: Id<"stocks">; payload: Partial<StockPayload> };
type StockScalarColumn = {
	name: string;
	kind: "number" | "text";
	group: "indicator" | "evaluation";
};

const ETF_MARKET_CAP_FIELDS = ["market_cap", "fx"] as const;

const STOCK_TEXT_INDICATOR_COLUMNS = [
	"name",
	"strategy",
	"quote_type",
	"equity_type",
	"fx",
	"sector_name",
	"industry_name",
	"earning_direction",
	"market_data_fetched_at",
	"market_snapshot_fetched_at",
	"statistics_fetched_at",
	"financials_fetched_at",
	"ratings_fetched_at",
	"industry_labels_fetched_at",
	"etf_holdings_fetched_at",
] as const;

const STOCK_NUMERIC_INDICATOR_COLUMNS = [
	"price",
	"change",
	"change_percent_1d",
	"change_percent_1m",
	"change_percent_3m",
	"change_percent_6m",
	"change_percent_1y",
	"change_percent_mtd",
	"change_percent_ytd",
	"fifty_day_change_percent",
	"one_hundred_day_change_percent",
	"two_hundred_day_change_percent",
	"market_cap",
	"pe",
	"pe_forward",
	"ps",
	"ps_forward",
	"peg",
	"beta",
	"iv",
	"rsi",
	"median_upside",
	"revenue",
	"revenue_growth",
	"revenue_growth_1y",
	"revenue_cagr_3y",
	"eps_growth",
	"fcf_growth_1y",
	"fcf_cagr_3y",
	"gross_margin",
	"gross_margin_median_3y",
	"operating_margin",
	"operating_margin_median_3y",
	"operating_margin_delta_vs_3y",
	"operating_margin_std_3y",
	"roe",
	"roic",
	"debt_to_equity",
	"free_cash_flow",
	"fcf_margin_median_3y",
	"shares_change_1y",
	"shares_change_cagr_3y",
	"shareholder_yield",
	"research_and_development",
	"rd_intensity",
	"rd_knowledge_capital",
] as const;

const STOCK_NUMERIC_EVALUATION_COLUMNS = [
	"overall_score",
	"quality_score",
	"valuation_score",
	"moat_score",
	"upside_score",
	"market_cap_score",
	"tactical_score",
] as const;

const STOCK_EVALUATION_REASON_COLUMNS = [
	["moat_score", "moat_reasons"],
	["quality_score", "quality_reasons"],
	["upside_score", "upside_reasons"],
] as const;

const STOCK_FUTURE_OUTLOOK_COLUMNS = {
	score: "future_score",
	reasons: "future_reasons",
} as const;

const STOCK_ARRAY_INDICATOR_COLUMNS = [
	"industry_labels",
	"ratings",
	"etf_holdings",
	"etf_sectors",
] as const;

const STOCK_SCALAR_COLUMNS: readonly StockScalarColumn[] = [
	...STOCK_TEXT_INDICATOR_COLUMNS.map((name) => ({
		name,
		kind: "text" as const,
		group: "indicator" as const,
	})),
	...STOCK_NUMERIC_INDICATOR_COLUMNS.map((name) => ({
		name,
		kind: "number" as const,
		group: "indicator" as const,
	})),
	...STOCK_NUMERIC_EVALUATION_COLUMNS.map((name) => ({
		name,
		kind: "number" as const,
		group: "evaluation" as const,
	})),
];

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
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	return value as GenericRow;
}

function normalizeEvaluation(value: unknown): GenericRow {
	return { ...normalizeObject(value) };
}

function normalizeEtfHoldings(value: unknown): GenericRow[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const holdings: GenericRow[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			continue;
		}

		const row = item as GenericRow;
		const ticker =
			typeof row.ticker === "string" ? row.ticker.toUpperCase().trim() : "";
		const weight = Number(row.weight);
		if (!ticker || !Number.isFinite(weight) || weight <= 0) {
			continue;
		}

		const name =
			typeof row.name === "string" && row.name.trim() ? row.name.trim() : null;
		holdings.push({ ticker, name, weight });
	}
	return holdings;
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
	if (Array.isArray(indicators.etf_holdings)) {
		indicators.etf_holdings = normalizeEtfHoldings(indicators.etf_holdings);
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
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value as GenericRow;
}

function scoreFromValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return scoreFromValue((value as GenericRow).score);
	}
	return null;
}

function textValue(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const text = value.trim();
	return text ? text : null;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function scoreReasons(value: unknown): string[] | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const reasons = normalizeLabels((value as GenericRow).reasons);
	return reasons.length > 0 ? reasons : undefined;
}

function applyScalarColumns(
	row: GenericRow,
	indicators: GenericRow,
	evaluation: GenericRow,
): void {
	for (const column of STOCK_SCALAR_COLUMNS) {
		const value = row[column.name];
		if (value === undefined) {
			continue;
		}
		if (column.group === "indicator") {
			indicators[column.name] = value;
		} else {
			evaluation[column.name] = value;
		}
	}
}

function applyEvaluationReasons(row: GenericRow, evaluation: GenericRow): void {
	for (const [scoreField, reasonsField] of STOCK_EVALUATION_REASON_COLUMNS) {
		const reasons = normalizeLabels(row[reasonsField]);
		if (reasons.length > 0) {
			evaluation[scoreField] = {
				score: evaluation[scoreField] ?? null,
				reasons,
			};
		}
	}
}

function applyFutureOutlook(row: GenericRow, evaluation: GenericRow): void {
	if (row[STOCK_FUTURE_OUTLOOK_COLUMNS.score] !== undefined) {
		evaluation.score = row[STOCK_FUTURE_OUTLOOK_COLUMNS.score];
	}
	const reasons = normalizeLabels(row[STOCK_FUTURE_OUTLOOK_COLUMNS.reasons]);
	if (reasons.length > 0) {
		evaluation.reasons = reasons;
	}
}

function applyArrayIndicators(row: GenericRow, indicators: GenericRow): void {
	for (const field of STOCK_ARRAY_INDICATOR_COLUMNS) {
		const value = row[field];
		if (Array.isArray(value) && value.length > 0) {
			indicators[field] = value;
		}
	}
}

function toStockPayload(
	row: GenericRow & { ticker: string; updatedAt: number },
) {
	const indicators = normalizeIndicators(row.indicators);
	const evaluation = normalizeEvaluation(row.evaluation);
	applyScalarColumns(row, indicators, evaluation);
	applyEvaluationReasons(row, evaluation);
	applyFutureOutlook(row, evaluation);
	applyArrayIndicators(row, indicators);
	return {
		ticker: row.ticker,
		indicators,
		evaluation,
		labels: normalizeLabels(row.labels),
		updatedAt: row.updatedAt,
	};
}

function flattenStockPayload({
	ticker,
	indicators,
	evaluation,
	labels,
	updatedAt,
}: {
	ticker: string;
	indicators: GenericRow;
	evaluation: GenericRow;
	labels: string[];
	updatedAt: number;
}): StockPayload {
	const payload: StockPayload = {
		ticker,
		labels,
		updatedAt,
	};

	for (const column of STOCK_SCALAR_COLUMNS) {
		const source = column.group === "indicator" ? indicators : evaluation;
		payload[column.name] =
			column.kind === "number"
				? scoreFromValue(source[column.name])
				: textValue(source[column.name]);
	}
	for (const [scoreField, reasonsField] of STOCK_EVALUATION_REASON_COLUMNS) {
		payload[reasonsField] = scoreReasons(evaluation[scoreField]) ?? [];
	}
	payload[STOCK_FUTURE_OUTLOOK_COLUMNS.score] = scoreFromValue(
		evaluation.score,
	);
	payload[STOCK_FUTURE_OUTLOOK_COLUMNS.reasons] = normalizeLabels(
		evaluation.reasons,
	);
	for (const field of STOCK_ARRAY_INDICATOR_COLUMNS) {
		payload[field] = arrayValue(indicators[field]);
	}

	return payload;
}

function buildStockPayload(
	entry: GenericRow,
	{
		existing,
		now,
	}: {
		existing?: StockDocument | null;
		now: number;
	},
): StockPayload {
	const existingPayload = existing
		? toStockPayload(
				existing as GenericRow & {
					ticker: string;
					updatedAt: number;
				},
			)
		: null;
	const indicators =
		entry.indicators === undefined
			? normalizeIndicators(existingPayload?.indicators)
			: normalizeIndicators(entry.indicators);
	const evaluation =
		entry.evaluation === undefined
			? normalizeEvaluation(existingPayload?.evaluation)
			: normalizeEvaluation(entry.evaluation);
	const labels =
		entry.labels === undefined
			? normalizeLabels(existingPayload?.labels)
			: normalizeLabels(entry.labels);
	return flattenStockPayload({
		ticker: normalizeTicker(entry.ticker),
		indicators,
		evaluation,
		labels,
		updatedAt: now,
	});
}

function buildStockWrite(
	existing: StockDocument | null | undefined,
	payload: StockPayload,
): StockWrite {
	if (!existing) {
		return { kind: "insert", payload };
	}

	const patch = changedFields(existing as GenericRow, payload);
	return patch
		? { kind: "patch", id: existing._id, payload: patch }
		: { kind: "skip" };
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

export const list = query({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db.query("stocks").collect();
		return rows
			.map((row) =>
				toStockPayload(
					row as GenericRow & { ticker: string; updatedAt: number },
				),
			)
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
		return toStockPayload({
			...(row as GenericRow),
			ticker,
			updatedAt: row.updatedAt,
		});
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
			.map((row) =>
				toStockPayload(
					row as GenericRow & { ticker: string; updatedAt: number },
				),
			)
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
			return { ok: true, updated: true };
		}
		if (write.kind === "skip") {
			return { ok: true, updated: false };
		}

		await ctx.db.insert("stocks", write.payload);
		return { ok: true, updated: true };
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
