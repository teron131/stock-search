import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	BackendStore,
	CachedNewsRow,
	PortfolioRecord,
	PositionRow,
	StockEntry,
} from "../../src/stock-search/api/data-store.js";
import { createMiscRouter } from "../../src/stock-search/api/routes/misc.js";
import { STOCK_NEWS } from "../../src/stock-search/api/route-paths.js";
import type { NewsAnalysis, NewsArticle } from "../../src/stock-search/models/schemas.js";
import * as newsOrchestrator from "../../src/stock-search/news/orchestrator.js";
import * as newsProviders from "../../src/stock-search/news/providers/index.js";

function makeNews({
	title,
	url,
	daysAgo,
}: {
	title: string;
	url: string;
	daysAgo: number;
}): NewsArticle {
	return {
		title,
		url,
		date: "2026-04-17",
		days_ago: daysAgo,
		summary: "",
		relevancy: "low",
		category: "other",
		sentiment: "neutral",
		metadata: {
			provider: "test",
		},
	};
}

function withAnalysis(
	news: NewsArticle,
	{
		summary,
		category = "company_news",
		sentiment = "neutral",
		metadata,
		relevancy = "high",
	}: {
		summary: string;
		category?: NewsArticle["category"];
		sentiment?: NewsArticle["sentiment"];
		metadata?: NewsArticle["metadata"];
		relevancy?: NewsArticle["relevancy"];
	},
): NewsArticle {
	return {
		...news,
		summary,
		relevancy,
		category,
		sentiment,
		metadata: metadata ?? news.metadata,
	};
}

function makeStore(): BackendStore {
	return {
		backendName: "sqlite",
		async loadPortfolio(): Promise<PortfolioRecord> {
			return {
				positions: [],
				portfolioStats: null,
			};
		},
		async savePortfolio(_input: PortfolioRecord & { key?: string }): Promise<void> {},
		async loadPositions(): Promise<PositionRow[]> {
			return [];
		},
		async savePositions(_positions: PositionRow[]): Promise<void> {},
		async loadStocks(): Promise<Record<string, StockEntry>> {
			return {};
		},
		async loadStock(_ticker: string): Promise<StockEntry | null> {
			return null;
		},
		async upsertStocks(
			_rows: Array<{
				ticker: string;
				indicators?: Record<string, unknown>;
				evaluation?: Record<string, unknown>;
				labels?: string[];
			}>,
		): Promise<void> {},
		async loadNews(_key?: string): Promise<CachedNewsRow[]> {
			return [];
		},
		async saveNews(_rows: CachedNewsRow[], _key?: string): Promise<void> {},
		async getMetaValue(_key: string): Promise<string | null> {
			return null;
		},
		async setMetaValue(_key: string, _value: string): Promise<void> {},
	};
}

describe("news orchestrator parity", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		newsOrchestrator.ANALYSIS_CACHE.clear();
		newsOrchestrator.PROVIDER_RATE_LIMITERS.clear();
		for (const [providerName, limit] of Object.entries(
			newsOrchestrator.PROVIDER_RATE_LIMITS,
		)) {
			newsOrchestrator.PROVIDER_RATE_LIMITERS.set(
				providerName,
				new newsOrchestrator.ProviderRequestLimiter(limit),
			);
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		globalThis.fetch = originalFetch;
		newsOrchestrator.ANALYSIS_CACHE.clear();
	});

	it("filters non-english unicode articles from the finalized feed", () => {
		const englishNews = withAnalysis(
			makeNews({
				title: "TSMC plans sub-1nm pilot production in 2029",
				url: "https://example.com/english",
				daysAgo: 0,
			}),
			{
				summary: "TSMC is preparing an early pilot line for sub-1nm production.",
				category: "industry_news",
			},
		);
		const accentedNonEnglishNews = withAnalysis(
			makeNews({
				title: "TSMC du kien san xuat thu nghiem chip duoi 1nm vao nam 2029",
				url: "https://example.com/accented-non-english",
				daysAgo: 0,
			}),
			{
				summary:
					"TSMC dự kiến sản xuất thử nghiệm chip dưới 1nm bắt đầu vào năm 2029.",
				category: "industry_news",
			},
		);

		const result = newsOrchestrator._finalizeNewsFeed([
			englishNews,
			accentedNonEnglishNews,
		]);

		expect(result.map((item) => item.url)).toEqual([
			"https://example.com/english",
		]);
	});

	it("drops articles older than three days from the finalized feed", () => {
		const retainedNews = withAnalysis(
			makeNews({
				title: "Retained within window",
				url: "https://example.com/within-window",
				daysAgo: 3,
			}),
			{
				summary: "Still current enough for the feed.",
			},
		);
		const expiredNews = withAnalysis(
			makeNews({
				title: "Expired outside window",
				url: "https://example.com/outside-window",
				daysAgo: 4,
			}),
			{
				summary: "Too old for the live feed.",
			},
		);

		const result = newsOrchestrator._finalizeNewsFeed([
			retainedNews,
			expiredNews,
		]);

		expect(result.map((item) => item.url)).toEqual([
			"https://example.com/within-window",
		]);
	});

	it("drops articles fetched outside the retention window", () => {
		const currentTime = new Date("2026-04-21T00:00:00.000Z");
		const retainedNews = withAnalysis(
			makeNews({
				title: "Freshly fetched",
				url: "https://example.com/fresh-fetch",
				daysAgo: 1,
			}),
			{
				summary: "Kept because both windows are inside the threshold.",
				metadata: {
					provider: "test",
					fetched_at: "2026-04-19T00:00:00.000Z",
					published_at: "2026-04-20T00:00:00.000Z",
				},
			},
		);
		const expiredNews = withAnalysis(
			makeNews({
				title: "Stale fetch",
				url: "https://example.com/stale-fetch",
				daysAgo: 1,
			}),
			{
				summary: "Dropped because fetched time is too old.",
				metadata: {
					provider: "test",
					fetched_at: "2026-04-17T00:00:00.000Z",
					published_at: "2026-04-20T00:00:00.000Z",
				},
			},
		);

		const result = [retainedNews, expiredNews].filter((item) =>
			newsOrchestrator._isNewsItemWithinRetention(item, {
				now: currentTime,
			}),
		);

		expect(result.map((item) => item.url)).toEqual([
			"https://example.com/fresh-fetch",
		]);
	});

	it("tolerates provider failures and preserves the Python selection flow", async () => {
		const dedupedInputs: string[] = [];

		vi.spyOn(newsProviders, "getNewsNewsDataAsync").mockResolvedValue([
			makeNews({
				title: "Primary A",
				url: "https://example.com/a",
				daysAgo: 2,
			}),
			makeNews({
				title: "Filter Low",
				url: "https://example.com/b",
				daysAgo: 0,
			}),
		]);
		vi.spyOn(newsProviders, "getNewsMassiveAsync").mockRejectedValue(
			new Error("massive offline"),
		);
		const exaSpy = vi
			.spyOn(newsProviders, "getNewsExaAsync")
			.mockResolvedValue([
				makeNews({
					title: "Duplicate A",
					url: "https://example.com/a?utm_source=test",
					daysAgo: 1,
				}),
			]);
		vi.spyOn(newsProviders, "getNewsNewsApiAsync").mockResolvedValue([
			makeNews({
				title: "Keep Medium",
				url: "https://example.com/c",
				daysAgo: 1,
			}),
		]);
		vi.spyOn(newsProviders, "getNewsYahooFinance").mockResolvedValue([
			makeNews({
				title: "Filter Failed",
				url: "https://example.com/d",
				daysAgo: 3,
			}),
		]);
		vi.spyOn(newsOrchestrator.newsRuntime, "analyzeNews").mockImplementation(
			async (ticker: string, newsList: NewsArticle[]): Promise<NewsAnalysis[]> => {
				expect(ticker).toBe("NVDA");
				dedupedInputs.push(...newsList.map((news) => news.url));
				return [
					{
						summary: "Keep this",
						relevancy: "high",
						category: "company_news",
						sentiment: "bullish",
					},
					{
						summary: "Low relevance",
						relevancy: "low",
						category: "market_news",
						sentiment: "neutral",
					},
					{
						summary: "Useful update",
						relevancy: "medium",
						category: "market_news",
						sentiment: "neutral",
					},
					{
						summary: "[FAILED TO FETCH]",
						relevancy: "high",
						category: "other",
						sentiment: "neutral",
					},
				];
			},
		);

		const result = await newsOrchestrator.getNewsAsync("NVDA");

		expect(exaSpy).toHaveBeenCalledOnce();
		expect(dedupedInputs).toEqual([
			"https://example.com/a",
			"https://example.com/b",
			"https://example.com/c",
			"https://example.com/d",
		]);
		expect(result.map((item) => item.title)).toEqual([
			"Keep Medium",
			"Primary A",
		]);
	});

	it("reuses cached url analysis for normalized duplicate urls", async () => {
		const webloaderCalls: string[][] = [];
		const invokeCalls: string[] = [];

		class FakeModel {
			withStructuredOutput(): FakeModel {
				return this;
			}

			async invoke(prompt: string): Promise<NewsAnalysis> {
				invokeCalls.push(prompt);
				return {
					summary: "Cached summary",
					relevancy: "high",
					category: "analysis",
					sentiment: "bullish",
				};
			}
		}

		newsOrchestrator.ANALYSIS_CACHE.clear();
		vi.spyOn(newsOrchestrator.newsPipelineDeps, "chatOpenAI").mockImplementation(
			() => new FakeModel() as never,
		);
		vi.spyOn(newsOrchestrator.newsPipelineDeps, "webloader").mockImplementation(
			async (urls: string | string[]) => {
				const normalizedUrls = Array.isArray(urls) ? urls : [urls];
				webloaderCalls.push([...normalizedUrls]);
				return normalizedUrls.map(() => "Article body");
			},
		);

		const firstBatch = [
			makeNews({
				title: "A",
				url: "https://example.com/a?utm_source=alpha",
				daysAgo: 0,
			}),
		];
		const secondBatch = [
			makeNews({
				title: "A",
				url: "https://example.com/a?utm_source=beta",
				daysAgo: 0,
			}),
		];

		const firstResult = await newsOrchestrator._analyzeNews("NVDA", firstBatch);
		const secondResult = await newsOrchestrator._analyzeNews("NVDA", secondBatch);

		expect(firstResult[0].summary).toBe("Cached summary");
		expect(secondResult[0].summary).toBe("Cached summary");
		expect(webloaderCalls).toEqual([
			["https://example.com/a?utm_source=alpha"],
		]);
		expect(invokeCalls).toHaveLength(1);
	});

	it("falls back to macro chapters when the summary model omits them", async () => {
		class FakeModel {
			withStructuredOutput(): FakeModel {
				return this;
			}

			async invoke(): Promise<{ macros: []; top_tickers: [] }> {
				return {
					macros: [],
					top_tickers: [],
				};
			}
		}

		vi.spyOn(newsOrchestrator.newsPipelineDeps, "chatOpenAI").mockImplementation(
			() => new FakeModel() as never,
		);

		const result = await newsOrchestrator.summarizePortfolioNewsAsync(
			[
				{
					ticker: "NVDA",
					quantity: 10,
					total: 1000,
					weight_pct: 100,
				},
			],
			[
				{
					title: "Oil spikes as market digests Middle East risk",
					summary:
						"Oil moved higher as investors absorbed fresh Middle East supply risk across the broader tape.",
					relevancy: "high",
					category: "macro_economics",
					sentiment: "neutral",
					source_tickers: ["NVDA"],
				},
			],
		);

		expect(result.has_news).toBe(true);
		expect(result.macros).toHaveLength(1);
		expect(result.macros[0].paragraph).toBe(
			"Oil moved higher as investors absorbed fresh Middle East supply risk across the broader tape.",
		);
		expect(result.macros[0].tickers).toEqual(["NVDA"]);
	});

	it("skips exa when primary providers already have enough results", async () => {
		vi.spyOn(newsProviders, "getNewsNewsDataAsync").mockResolvedValue([
			makeNews({
				title: "A",
				url: "https://example.com/a",
				daysAgo: 0,
			}),
			makeNews({
				title: "B",
				url: "https://example.com/b",
				daysAgo: 0,
			}),
		]);
		vi.spyOn(newsProviders, "getNewsMassiveAsync").mockResolvedValue([
			makeNews({
				title: "C",
				url: "https://example.com/c",
				daysAgo: 1,
			}),
		]);
		vi.spyOn(newsProviders, "getNewsNewsApiAsync").mockResolvedValue([
			makeNews({
				title: "D",
				url: "https://example.com/d",
				daysAgo: 2,
			}),
		]);
		vi.spyOn(newsProviders, "getNewsYahooFinance").mockResolvedValue([]);
		const exaSpy = vi
			.spyOn(newsProviders, "getNewsExaAsync")
			.mockRejectedValue(
				new Error(
					"Exa should not run when primary providers already have enough items",
				),
			);
		vi.spyOn(newsOrchestrator.newsRuntime, "analyzeNews").mockImplementation(
			async (_ticker, newsList) =>
				newsList.map((_, index) => ({
					summary: `summary-${index}`,
					relevancy: "high",
					category: "company_news",
					sentiment: "neutral",
				})),
		);

		const result = await newsOrchestrator.getNewsAsync("NVDA", 3, 4);

		expect(exaSpy).not.toHaveBeenCalled();
		expect(result.map((item) => item.url)).toEqual([
			"https://example.com/a",
			"https://example.com/b",
			"https://example.com/c",
			"https://example.com/d",
		]);
	});

	it("skips rate-limited providers before invoking them", async () => {
		vi.spyOn(newsProviders, "getNewsNewsDataAsync").mockResolvedValue([
			makeNews({
				title: "A",
				url: "https://example.com/a",
				daysAgo: 0,
			}),
		]);
		const massiveSpy = vi
			.spyOn(newsProviders, "getNewsMassiveAsync")
			.mockResolvedValue([
				makeNews({
					title: "B",
					url: "https://example.com/b",
					daysAgo: 0,
				}),
			]);
		vi.spyOn(newsProviders, "getNewsNewsApiAsync").mockResolvedValue([
			makeNews({
				title: "C",
				url: "https://example.com/c",
				daysAgo: 1,
			}),
		]);
		vi.spyOn(newsProviders, "getNewsYahooFinance").mockResolvedValue([]);
		vi.spyOn(newsProviders, "getNewsExaAsync").mockResolvedValue([
			makeNews({
				title: "D",
				url: "https://example.com/d",
				daysAgo: 2,
			}),
		]);
		newsOrchestrator.PROVIDER_RATE_LIMITERS.set(
			"massive",
			new newsOrchestrator.ProviderRequestLimiter({
				maxRequests: 0,
				windowMs: 60 * 1000,
			}),
		);
		vi.spyOn(newsOrchestrator.newsRuntime, "analyzeNews").mockImplementation(
			async (_ticker, newsList) =>
				newsList.map(() => ({
					summary: "summary",
					relevancy: "high",
					category: "company_news",
					sentiment: "neutral",
				})),
		);

		const result = await newsOrchestrator.getNewsAsync("NVDA", 3, 4);

		expect(massiveSpy).not.toHaveBeenCalled();
		expect(result.map((item) => item.url)).toEqual([
			"https://example.com/a",
			"https://example.com/c",
			"https://example.com/d",
		]);
	});

	it("caps massive requests to the provider max", async () => {
		const client = {
			lastParams: null as Record<string, string> | null,
			async get({
				params,
			}: {
				url: string;
				params: Record<string, string>;
			}): Promise<{ json(): Promise<unknown>; raise_for_status(): void }> {
				this.lastParams = params;
				return {
					async json(): Promise<unknown> {
						return { results: [] };
					},
					raise_for_status(): void {},
				};
			},
		};

		await newsProviders.getNewsMassiveAsync({
			ticker: "NVDA",
			maxResults: 9999,
			client,
		});

		expect(client.lastParams).not.toBeNull();
		expect(client.lastParams?.limit).toBe(
			String(newsProviders.MASSIVE_MAX_RESULTS),
		);
	});

	it("caps yahoo finance requests to the provider max", async () => {
		let requestedUrl = "";
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			requestedUrl = String(input);
			return new Response(JSON.stringify({ news: [] }), {
				status: 200,
				headers: {
					"content-type": "application/json",
				},
			});
		}) as typeof fetch;

		const result = await newsProviders.getNewsYahooFinance({
			ticker: "NVDA",
			maxResults: 999,
		});

		expect(result).toEqual([]);
		expect(new URL(requestedUrl).searchParams.get("newsCount")).toBe(
			String(newsProviders.YFINANCE_MAX_RESULTS),
		);
	});

	it("uses the live news pipeline on the stock news route", async () => {
		const app = new Hono().route("/", createMiscRouter(makeStore()));
		vi.spyOn(newsOrchestrator, "getNewsAsync").mockResolvedValue([
			{
				title: "NVDA headline",
				url: "https://example.com/nvda-news-1",
				summary: "Real fetched summary",
				relevancy: "high",
				category: "company_news",
				sentiment: "bullish",
				date: null,
				days_ago: null,
				metadata: {
					provider: "test",
				},
			},
		]);

		const response = await app.request(STOCK_NEWS.replace(":ticker", "nvda"));

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const payload = (await response.json()) as NewsArticle[];
		expect(payload).toHaveLength(1);
		expect(payload[0].metadata?.provider).toBe("test");
		expect(payload[0].url).toContain("nvda");
	});
});
