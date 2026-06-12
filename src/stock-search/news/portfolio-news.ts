/** Build, persist, and load shared portfolio news payloads. */

import type {
	PortfolioNewsPayload,
	PortfolioNewsSummaryWrite,
	PortfolioNewsWrite,
	TickerNewsGroup,
} from "../models/schemas.js";
import {
	PortfolioNewsPayloadSchema,
	PortfolioNewsSummaryWriteSchema,
	PortfolioNewsWriteSchema,
} from "../models/schemas.js";
import type { BackendStore, CachedNewsRow } from "../storage/index.js";
import { normalizeTicker } from "../utils.js";
import type { NewsFetchOptions } from "./pipeline.js";
import { getRawFastNewsAsync } from "./pipeline.js";

const PORTFOLIO_NEWS_STORAGE_KEY_PREFIX = "portfolio-news";
const PORTFOLIO_NEWS_STORAGE_TICKER = "__PORTFOLIO__";
const DEFAULT_PORTFOLIO_NEWS_KEY = "default";
const DEFAULT_RAW_BUNDLE_DAYS = 2;
const DEFAULT_RAW_BUNDLE_MAX_RESULTS = 8;
const MAX_RAW_BUNDLE_TICKERS = 50;

export type PortfolioRawNewsBundle = {
	generated_at: string;
	n_days: number;
	max_results_per_ticker: number;
	tickers: TickerNewsGroup[];
	warnings: string[];
};

type RawTickerNewsResult = {
	group: TickerNewsGroup;
	warning?: string;
};

export async function loadPortfolioNews(
	store: BackendStore,
	key = DEFAULT_PORTFOLIO_NEWS_KEY,
): Promise<PortfolioNewsPayload | null> {
	const normalizedKey = normalizePortfolioNewsKey(key);
	const rows = await store.loadNews(portfolioNewsStorageKey(normalizedKey));
	const portfolioNewsRow = rows.find(
		(row) => row.ticker === PORTFOLIO_NEWS_STORAGE_TICKER,
	);
	if (!portfolioNewsRow) {
		return null;
	}

	const parsedPortfolioNews = PortfolioNewsPayloadSchema.safeParse({
		key: normalizedKey,
		...portfolioNewsRow.row,
	});
	return parsedPortfolioNews.success ? parsedPortfolioNews.data : null;
}

export async function savePortfolioNews(
	store: BackendStore,
	input: unknown,
): Promise<PortfolioNewsPayload> {
	const writePayload = PortfolioNewsWriteSchema.parse(input);
	const currentPortfolioNews = await loadPortfolioNews(store, writePayload.key);
	const portfolioNews = normalizePortfolioNewsForStorage(
		writePayload,
		currentPortfolioNews,
	);
	await store.saveNews(
		[portfolioNewsToRow(portfolioNews)],
		portfolioNewsStorageKey(portfolioNews.key),
	);
	return portfolioNews;
}

export async function loadPortfolioNewsSummary(
	store: BackendStore,
	key = DEFAULT_PORTFOLIO_NEWS_KEY,
) {
	const portfolioNews = await loadPortfolioNews(store, key);
	return portfolioNews?.summary ?? null;
}

export async function savePortfolioNewsSummary(
	store: BackendStore,
	input: unknown,
): Promise<PortfolioNewsPayload> {
	const summaryWrite = PortfolioNewsSummaryWriteSchema.parse(input);
	const portfolioNews = await normalizePortfolioNewsSummaryForStorage(
		store,
		summaryWrite,
	);
	await store.saveNews(
		[portfolioNewsToRow(portfolioNews)],
		portfolioNewsStorageKey(portfolioNews.key),
	);
	return portfolioNews;
}

export async function buildPortfolioRawNewsBundle({
	tickers,
	nDays = DEFAULT_RAW_BUNDLE_DAYS,
	maxResultsPerTicker = DEFAULT_RAW_BUNDLE_MAX_RESULTS,
	newsOptions = {},
}: {
	tickers: string[];
	nDays?: number;
	maxResultsPerTicker?: number;
	newsOptions?: Omit<NewsFetchOptions, "mode" | "nDays" | "maxResults">;
}): Promise<PortfolioRawNewsBundle> {
	const normalizedTickers = normalizeTickerList(tickers);
	const maxResults = Math.max(1, Math.floor(maxResultsPerTicker));
	const days = Math.max(1, Math.floor(nDays));
	const generatedAt = new Date().toISOString();

	const results = await Promise.all(
		normalizedTickers.map((ticker) =>
			buildRawTickerNewsResult({
				ticker,
				generatedAt,
				days,
				maxResults,
				newsOptions,
			}),
		),
	);

	return {
		generated_at: generatedAt,
		n_days: days,
		max_results_per_ticker: maxResults,
		tickers: results.map((result) => result.group),
		warnings: results.flatMap((result) =>
			result.warning ? [result.warning] : [],
		),
	};
}

function normalizePortfolioNewsKey(key: string | undefined): string {
	const trimmedKey = String(key || DEFAULT_PORTFOLIO_NEWS_KEY).trim();
	return trimmedKey || DEFAULT_PORTFOLIO_NEWS_KEY;
}

function portfolioNewsStorageKey(key: string): string {
	return `${PORTFOLIO_NEWS_STORAGE_KEY_PREFIX}:${normalizePortfolioNewsKey(key)}`;
}

function normalizeTickerList(tickers: string[]): string[] {
	return Array.from(
		new Set(tickers.map((ticker) => normalizeTicker(ticker)).filter(Boolean)),
	).slice(0, MAX_RAW_BUNDLE_TICKERS);
}

function portfolioNewsToRow(
	portfolioNews: PortfolioNewsPayload,
): CachedNewsRow {
	const key = normalizePortfolioNewsKey(portfolioNews.key);
	return {
		key: portfolioNewsStorageKey(key),
		ticker: PORTFOLIO_NEWS_STORAGE_TICKER,
		row: portfolioNews,
		updatedAt: Date.parse(portfolioNews.refreshed_at) || Date.now(),
	};
}

function normalizePortfolioNewsForStorage(
	writePayload: PortfolioNewsWrite,
	currentPortfolioNews: PortfolioNewsPayload | null,
): PortfolioNewsPayload {
	const refreshedAt = new Date().toISOString();
	const asOfDate = portfolioNewsAsOfDate(writePayload);
	const normalizedPortfolioNews = {
		key: normalizePortfolioNewsKey(writePayload.key),
		as_of_date: asOfDate,
		window_start: writePayload.window_start ?? null,
		window_end: writePayload.window_end ?? asOfDate,
		producer: "external-agent" as const,
		refreshed_at: refreshedAt,
		status: "fresh" as const,
		ticker_summaries: writePayload.ticker_summaries.map((summary) => ({
			...summary,
			status: "fresh" as const,
		})),
		articles_by_ticker: [],
		warnings: [],
	};
	const portfolioNews = PortfolioNewsPayloadSchema.parse({
		...normalizedPortfolioNews,
		summary: currentPortfolioNews?.summary ?? null,
	});
	return portfolioNews;
}

async function normalizePortfolioNewsSummaryForStorage(
	store: BackendStore,
	input: PortfolioNewsSummaryWrite,
): Promise<PortfolioNewsPayload> {
	const currentPortfolioNews = await loadPortfolioNews(store, input.key);
	const asOfDate =
		input.as_of_date ??
		currentPortfolioNews?.as_of_date ??
		input.window_end ??
		new Date().toISOString().slice(0, 10);
	return PortfolioNewsPayloadSchema.parse({
		key: normalizePortfolioNewsKey(input.key),
		as_of_date: asOfDate,
		window_start:
			input.window_start ?? currentPortfolioNews?.window_start ?? null,
		window_end:
			input.window_end ?? currentPortfolioNews?.window_end ?? asOfDate,
		producer: "external-agent",
		refreshed_at: new Date().toISOString(),
		status: "fresh",
		ticker_summaries: currentPortfolioNews?.ticker_summaries ?? [],
		articles_by_ticker: [],
		summary: input.summary,
		warnings: currentPortfolioNews?.warnings ?? [],
	});
}

function portfolioNewsAsOfDate(payload: PortfolioNewsWrite): string {
	if (payload.as_of_date) {
		return payload.as_of_date;
	}
	if (payload.window_end) {
		return payload.window_end;
	}
	return new Date().toISOString().slice(0, 10);
}

async function buildRawTickerNewsResult({
	ticker,
	generatedAt,
	days,
	maxResults,
	newsOptions,
}: {
	ticker: string;
	generatedAt: string;
	days: number;
	maxResults: number;
	newsOptions: Omit<NewsFetchOptions, "mode" | "nDays" | "maxResults">;
}): Promise<RawTickerNewsResult> {
	try {
		return {
			group: {
				ticker,
				articles: await getRawFastNewsAsync(ticker, {
					...newsOptions,
					nDays: days,
					maxResults,
				}),
				refreshed_at: generatedAt,
				status: "fresh",
			},
		};
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "news fetch failed";
		return {
			group: {
				ticker,
				articles: [],
				refreshed_at: generatedAt,
				status: "failed",
				error: message,
			},
			warning: `${ticker}: ${message}`,
		};
	}
}
