/** Miscellaneous API route module. */

import { Hono } from "hono";
import { z } from "zod";
import { runCorrelationReport } from "../../correlation.js";
import {
	PortfolioNewsSnapshotSchema,
	PortfolioNewsSummaryRequestArticleSchema,
	PortfolioNewsSummaryRequestRowSchema,
} from "../../models/schemas.js";
import * as newsOrchestrator from "../../news/orchestrator.js";
import {
	loadPortfolioNewsSnapshot,
	savePortfolioNewsSnapshot,
} from "../../news/snapshots.js";
import { loadEvalMap, loadStocksMap } from "../../portfolio/index.js";
import type { BackendStore } from "../../storage/index.js";
import { convexRealtimeTopics } from "../../storage/index.js";
import { normalizeTicker } from "../../utils.js";
import { buildColorStandardsPayload } from "../color-standards.js";
import { appConfig } from "../config.js";
import {
	COLOR_STANDARDS,
	EVAL,
	PORTFOLIO_CORRELATION,
	PORTFOLIO_NEWS_CACHE,
	PORTFOLIO_NEWS_SUMMARY,
	REALTIME_CONFIG,
	STOCK_NEWS_ROUTE,
	STOCKS,
} from "../route-paths.js";

const ARTICLE_CATEGORIES = new Set([
	"macro_economics",
	"industry_news",
	"market_news",
	"company_news",
	"earnings",
	"analyst_rating",
	"analysis",
	"other",
]);
const ARTICLE_RELEVANCIES = new Set(["high", "medium", "low"]);
const ARTICLE_SENTIMENTS = new Set(["bullish", "neutral", "bearish"]);
const CORRELATION_MODES = new Set(["raw", "market_neutral"]);
const NEWS_MODES = new Set(["raw-fast", "analyzed-slow"]);

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

function toNullableFiniteNumber(value: unknown): number | null {
	const number = Number(value ?? Number.NaN);
	return Number.isFinite(number) ? number : null;
}

function normalizeSourceTickers(record: Record<string, unknown>): string[] {
	const sourceTickers =
		record.source_tickers ??
		record.sourceTickers ??
		(typeof record.sourceTicker === "string" ? [record.sourceTicker] : []);

	return Array.isArray(sourceTickers)
		? sourceTickers.map((value) => String(value))
		: [];
}

function normalizePortfolioNewsSummaryRow(value: unknown): unknown {
	const record = asRecord(value);
	if (!record) {
		return value;
	}
	return {
		ticker: String(record.ticker ?? ""),
		quantity: toNullableFiniteNumber(record.quantity),
		total: toNullableFiniteNumber(record.total),
		weight_pct: toNullableFiniteNumber(record.weight_pct),
	};
}

function normalizePortfolioNewsSummaryArticle(value: unknown): unknown {
	const record = asRecord(value);
	if (!record) {
		return value;
	}

	const relevancy =
		typeof record.relevancy === "string" &&
		ARTICLE_RELEVANCIES.has(record.relevancy)
			? record.relevancy
			: "low";
	const category =
		typeof record.category === "string" &&
		ARTICLE_CATEGORIES.has(record.category)
			? record.category
			: "other";
	const sentiment =
		typeof record.sentiment === "string" &&
		ARTICLE_SENTIMENTS.has(record.sentiment)
			? record.sentiment
			: "neutral";

	return {
		title: typeof record.title === "string" ? record.title : null,
		summary: String(record.summary ?? ""),
		relevancy,
		category,
		sentiment,
		source_tickers: normalizeSourceTickers(record),
	};
}

function parseTickersQuery(rawValue: string | undefined): string[] | undefined {
	if (typeof rawValue !== "string" || !rawValue.trim()) {
		return undefined;
	}

	const tickers = [
		...new Set(
			rawValue
				.split(",")
				.map((ticker) => normalizeTicker(ticker))
				.filter(Boolean),
		),
	];
	return tickers.length > 0 ? tickers : undefined;
}

function parseCorrelationMode(
	rawValue: string | undefined,
): "raw" | "market_neutral" {
	const mode = String(rawValue || "raw").trim();
	return CORRELATION_MODES.has(mode)
		? (mode as "raw" | "market_neutral")
		: "raw";
}

function parseNewsMode(
	rawValue: string | undefined,
): newsOrchestrator.NewsFetchMode {
	const mode = String(rawValue || "raw-fast").trim();
	return NEWS_MODES.has(mode)
		? (mode as newsOrchestrator.NewsFetchMode)
		: "raw-fast";
}

function parsePositiveInteger(
	rawValue: string | undefined,
): number | undefined {
	if (typeof rawValue !== "string" || !rawValue.trim()) {
		return undefined;
	}
	const value = Number(rawValue);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function parseCacheKey(rawValue: string | undefined): string {
	const key = String(rawValue || "default").trim();
	return key || "default";
}

const PortfolioNewsSummaryPayloadSchema = z
	.object({
		rows: z
			.array(
				z.preprocess(
					normalizePortfolioNewsSummaryRow,
					PortfolioNewsSummaryRequestRowSchema,
				),
			)
			.default([]),
		items: z
			.array(
				z.preprocess(
					normalizePortfolioNewsSummaryArticle,
					PortfolioNewsSummaryRequestArticleSchema,
				),
			)
			.default([]),
	})
	.catch({
		rows: [],
		items: [],
	});

export function createMiscRouter(store: BackendStore): Hono {
	const router = new Hono();

	router.get(PORTFOLIO_NEWS_CACHE, async (c) => {
		c.header("Cache-Control", "no-store");
		const snapshot = await loadPortfolioNewsSnapshot(
			store,
			parseCacheKey(c.req.query("key")),
		);
		return c.json(snapshot ?? null);
	});

	router.post(PORTFOLIO_NEWS_CACHE, async (c) => {
		c.header("Cache-Control", "no-store");
		const input = PortfolioNewsSnapshotSchema.parse(
			await c.req.json().catch(() => null),
		);
		return c.json(await savePortfolioNewsSnapshot(store, input));
	});

	router.post(PORTFOLIO_NEWS_SUMMARY, async (c) => {
		c.header("Cache-Control", "no-store");
		const { rows, items } = PortfolioNewsSummaryPayloadSchema.parse(
			await c.req.json().catch(() => null),
		);
		return c.json(
			await newsOrchestrator.buildPortfolioNewsSummary(rows, items),
		);
	});

	router.get(STOCKS, async (c) => {
		c.header("Cache-Control", "no-store");
		return c.json(
			await loadStocksMap(store, parseTickersQuery(c.req.query("tickers"))),
		);
	});

	router.get(EVAL, async (c) => {
		c.header("Cache-Control", "no-store");
		return c.json(
			await loadEvalMap(store, parseTickersQuery(c.req.query("tickers"))),
		);
	});

	router.get(PORTFOLIO_CORRELATION, async (c) => {
		c.header("Cache-Control", "no-store");
		return c.json(
			await runCorrelationReport({
				tickers: parseTickersQuery(c.req.query("tickers")),
				correlationMode: parseCorrelationMode(c.req.query("mode")),
			}),
		);
	});

	router.get(COLOR_STANDARDS, (c) => {
		c.header(
			"Cache-Control",
			"public, max-age=3600, stale-while-revalidate=86400",
		);
		return c.json(buildColorStandardsPayload());
	});

	router.get(REALTIME_CONFIG, (c) => {
		c.header("Cache-Control", "no-store");
		return c.json({
			provider: "convex",
			enabled: Boolean(appConfig.convexSyncEnabled && appConfig.convexUrl),
			convex_url: appConfig.convexUrl || null,
			audience: appConfig.convexAudience || null,
			topics: [...convexRealtimeTopics],
		});
	});

	router.get(STOCK_NEWS_ROUTE, async (c) => {
		c.header("Cache-Control", "no-store");
		return c.json(
			await newsOrchestrator.getNewsAsync(c.req.param("ticker"), {
				resolveIdentity: true,
				mode: parseNewsMode(c.req.query("mode")),
				maxResults: parsePositiveInteger(c.req.query("max_results")),
			}),
		);
	});

	return router;
}
