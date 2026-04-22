/** Miscellaneous API route module. */

import { z } from "zod";
import { Hono } from "hono";

import { appConfig } from "../config.js";
import { buildColorStandardsPayload } from "../color-standards.js";
import type { BackendStore } from "../data-store.js";
import { loadEvalMap, loadStocksMap } from "../../portfolio.js";
import { getIndustrySnapshot } from "../../data-sources/stockanalysis/index.js";
import {
	portfolioNewsSummaryRequestArticleSchema,
	portfolioNewsSummaryRequestRowSchema,
} from "../../models/schemas.js";
import * as newsOrchestrator from "../../news/orchestrator.js";
import {
	COLOR_STANDARDS,
	EVAL,
	INDUSTRIES,
	PORTFOLIO_NEWS_SUMMARY,
	REALTIME_CONFIG,
	STOCK_NEWS,
	STOCKS,
} from "../route-paths.js";
import { convexRealtimeTopics } from "../data-store.js";

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

const portfolioNewsSummaryPayloadSchema = z
	.object({
		rows: z
			.array(
				z.preprocess(
					normalizePortfolioNewsSummaryRow,
					portfolioNewsSummaryRequestRowSchema,
				),
			)
			.default([]),
		items: z
			.array(
				z.preprocess(
					normalizePortfolioNewsSummaryArticle,
					portfolioNewsSummaryRequestArticleSchema,
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

	router.post(PORTFOLIO_NEWS_SUMMARY, async (c) => {
		c.header("Cache-Control", "no-store");
		const { rows, items } = portfolioNewsSummaryPayloadSchema.parse(
			await c.req.json().catch(() => null),
		);
		return c.json(await newsOrchestrator.buildPortfolioNewsSummary(rows, items));
	});

	router.get(STOCKS, async (c) => {
		c.header("Cache-Control", "no-store");
		return c.json(await loadStocksMap(store));
	});

	router.get(EVAL, async (c) => {
		c.header("Cache-Control", "no-store");
		return c.json(await loadEvalMap(store));
	});

	router.get(INDUSTRIES, async (c) => {
		c.header("Cache-Control", "no-store");
		return c.json(await getIndustrySnapshot());
	});

	router.get(COLOR_STANDARDS, (c) => {
		c.header("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
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

	router.get(STOCK_NEWS, async (c) => {
		c.header("Cache-Control", "no-store");
		return c.json(await newsOrchestrator.getNewsAsync(c.req.param("ticker")));
	});

	return router;
}
