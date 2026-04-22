/** Miscellaneous API route module. */

import { Hono } from "hono";

import { appConfig } from "../config.js";
import { buildColorStandardsPayload } from "../color-standards.js";
import type { BackendStore } from "../data-store.js";
import { loadEvalMap, loadStocksMap } from "../../portfolio.js";
import { getIndustrySnapshot } from "../../data-sources/stockanalysis/index.js";
import {
	type PortfolioNewsSummaryRequestArticle,
	type PortfolioNewsSummaryRequestRow,
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

export function createMiscRouter(store: BackendStore): Hono {
	const router = new Hono();

	router.post(PORTFOLIO_NEWS_SUMMARY, async (c) => {
		c.header("Cache-Control", "no-store");
		const payload = (await c.req.json().catch(() => null)) as
			| {
					rows?: Array<Record<string, unknown>>;
					items?: Array<Record<string, unknown>>;
			  }
			| null;
		const rows: PortfolioNewsSummaryRequestRow[] = Array.isArray(payload?.rows)
			? payload.rows
					.filter((row) => typeof row === "object" && row !== null)
					.map((row) => {
						const record = row as Record<string, unknown>;
						const quantity = Number(record.quantity ?? NaN);
						const total = Number(record.total ?? NaN);
						const weightPct = Number(record.weight_pct ?? NaN);
						return {
							ticker: String(record.ticker ?? ""),
							quantity: Number.isFinite(quantity) ? quantity : null,
							total: Number.isFinite(total) ? total : null,
							weight_pct: Number.isFinite(weightPct) ? weightPct : null,
						};
					})
			: [];
		const items: PortfolioNewsSummaryRequestArticle[] = Array.isArray(payload?.items)
			? payload.items
					.filter((item) => typeof item === "object" && item !== null)
					.map((item) => ({
						title:
							typeof (item as Record<string, unknown>).title === "string"
								? String((item as Record<string, unknown>).title)
								: null,
						summary: String((item as Record<string, unknown>).summary ?? ""),
						relevancy:
							(item as Record<string, unknown>).relevancy === "high" ||
							(item as Record<string, unknown>).relevancy === "medium"
								? ((item as Record<string, unknown>).relevancy as
										| "high"
										| "medium")
								: ("low" as const),
						category:
							typeof (item as Record<string, unknown>).category === "string"
								? ((item as Record<string, unknown>).category as PortfolioNewsSummaryRequestArticle["category"])
								: "other",
						sentiment:
							(item as Record<string, unknown>).sentiment === "bullish" ||
							(item as Record<string, unknown>).sentiment === "bearish"
								? ((item as Record<string, unknown>).sentiment as
										| "bullish"
										| "bearish")
								: ("neutral" as const),
						source_tickers: Array.isArray(
							(item as Record<string, unknown>).source_tickers,
						)
							? ((item as Record<string, unknown>).source_tickers as unknown[])
									.map((value) => String(value))
							: Array.isArray((item as Record<string, unknown>).sourceTickers)
								? ((item as Record<string, unknown>).sourceTickers as unknown[])
										.map((value) => String(value))
								: typeof (item as Record<string, unknown>).sourceTicker === "string"
									? [String((item as Record<string, unknown>).sourceTicker)]
									: [],
					}))
			: [];
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
