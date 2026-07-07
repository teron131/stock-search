/** Wires ticker-news fetches and persisted portfolio-news payloads onto Hono. */

import { Hono } from "hono";
import {
	PortfolioNewsSummaryWriteSchema,
	PortfolioNewsWriteSchema,
} from "../../models/schemas.js";
import * as newsPipeline from "../../news/pipeline.js";
import {
	loadPortfolioNews,
	loadPortfolioNewsSummary,
	parsePortfolioNewsSummaryPayload,
	savePortfolioNews,
	savePortfolioNewsSummary,
} from "../../news/portfolio-news.js";
import type { BackendStore } from "../../storage/index.js";
import {
	PORTFOLIO_NEWS,
	PORTFOLIO_NEWS_SUMMARIZE,
	PORTFOLIO_NEWS_SUMMARY,
	STOCK_NEWS_ROUTE,
} from "../route-paths.js";

const NEWS_MODES = new Set(["raw-fast", "analyzed-slow"]);
const MAX_STOCK_NEWS_RESULTS = 25;

/** Parse stock news mode query values with the raw-fast default. */
function parseNewsMode(
	rawValue: string | undefined,
): newsPipeline.NewsFetchMode {
	const mode = String(rawValue || "raw-fast").trim();
	return NEWS_MODES.has(mode)
		? (mode as newsPipeline.NewsFetchMode)
		: "raw-fast";
}

/** Parse positive integer query values capped at the route maximum. */
function parsePositiveInteger(
	rawValue: string | undefined,
): number | undefined {
	if (typeof rawValue !== "string" || !rawValue.trim()) {
		return undefined;
	}
	const value = Number(rawValue);
	return Number.isFinite(value) && value > 0
		? Math.min(MAX_STOCK_NEWS_RESULTS, Math.floor(value))
		: undefined;
}

/** Parse portfolio news storage keys with the default key fallback. */
function parsePortfolioNewsKey(rawValue: string | undefined): string {
	const key = String(rawValue || "default").trim();
	return key || "default";
}

/** Create routes for persisted portfolio news and ticker news fetches. */
export function createNewsRouter(store: BackendStore): Hono {
	const router = new Hono();

	router.get(PORTFOLIO_NEWS, async (c) => {
		c.header("Cache-Control", "no-store");
		const portfolioNews = await loadPortfolioNews(
			store,
			parsePortfolioNewsKey(c.req.query("key")),
		);
		return c.json(portfolioNews ?? null);
	});

	router.post(PORTFOLIO_NEWS, async (c) => {
		c.header("Cache-Control", "no-store");
		const input = PortfolioNewsWriteSchema.parse(
			await c.req.json().catch(() => null),
		);
		return c.json(await savePortfolioNews(store, input));
	});

	router.get(PORTFOLIO_NEWS_SUMMARY, async (c) => {
		c.header("Cache-Control", "no-store");
		return c.json(
			await loadPortfolioNewsSummary(
				store,
				parsePortfolioNewsKey(c.req.query("key")),
			),
		);
	});

	router.post(PORTFOLIO_NEWS_SUMMARY, async (c) => {
		c.header("Cache-Control", "no-store");
		const input = PortfolioNewsSummaryWriteSchema.parse(
			await c.req.json().catch(() => null),
		);
		return c.json(await savePortfolioNewsSummary(store, input));
	});

	router.post(PORTFOLIO_NEWS_SUMMARIZE, async (c) => {
		c.header("Cache-Control", "no-store");
		const { rows, items } = parsePortfolioNewsSummaryPayload(
			await c.req.json().catch(() => null),
		);
		return c.json(await newsPipeline.buildPortfolioNewsSummary(rows, items));
	});

	router.get(STOCK_NEWS_ROUTE, async (c) => {
		c.header("Cache-Control", "no-store");
		return c.json(
			await newsPipeline.getNewsAsync(c.req.param("ticker"), {
				resolveIdentity: true,
				mode: parseNewsMode(c.req.query("mode")),
				maxResults: parsePositiveInteger(c.req.query("max_results")),
			}),
		);
	});

	return router;
}
