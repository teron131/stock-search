/** Persist and load shared portfolio news snapshots. */

import type {
	PortfolioNewsSnapshot,
	PortfolioNewsSummaryResponse,
	TickerNewsSnapshot,
	TickerNewsSummarySnapshot,
} from "../models/schemas.js";
import { PortfolioNewsSnapshotSchema } from "../models/schemas.js";
import type { BackendStore, CachedNewsRow } from "../storage/index.js";
import { normalizeTicker } from "../utils.js";
import type { NewsFetchOptions } from "./orchestrator.js";
import { getRawFastNewsAsync } from "./orchestrator.js";

const PORTFOLIO_NEWS_CACHE_KEY_PREFIX = "portfolio-news";
const PORTFOLIO_NEWS_CACHE_TICKER = "__PORTFOLIO__";
const DEFAULT_SNAPSHOT_KEY = "default";
const DEFAULT_RAW_BUNDLE_DAYS = 2;
const DEFAULT_RAW_BUNDLE_MAX_RESULTS = 8;
const MAX_RAW_BUNDLE_TICKERS = 50;

export type PortfolioRawNewsBundle = {
	generated_at: string;
	n_days: number;
	max_results_per_ticker: number;
	tickers: TickerNewsSnapshot[];
	warnings: string[];
};

type RawTickerNewsResult = {
	group: TickerNewsSnapshot;
	warning?: string;
};

function normalizeSnapshotKey(key: string | undefined): string {
	const trimmedKey = String(key || DEFAULT_SNAPSHOT_KEY).trim();
	return trimmedKey || DEFAULT_SNAPSHOT_KEY;
}

function snapshotStorageKey(key: string): string {
	return `${PORTFOLIO_NEWS_CACHE_KEY_PREFIX}:${normalizeSnapshotKey(key)}`;
}

function normalizeTickerList(tickers: string[]): string[] {
	return Array.from(
		new Set(tickers.map((ticker) => normalizeTicker(ticker)).filter(Boolean)),
	).slice(0, MAX_RAW_BUNDLE_TICKERS);
}

function snapshotToRow(snapshot: PortfolioNewsSnapshot): CachedNewsRow {
	const key = normalizeSnapshotKey(snapshot.key);
	return {
		key: snapshotStorageKey(key),
		ticker: PORTFOLIO_NEWS_CACHE_TICKER,
		row: snapshot,
		updatedAt: Date.parse(snapshot.refreshed_at) || Date.now(),
	};
}

function summaryFromTickerSummaries(
	tickerSummaries: TickerNewsSummarySnapshot[],
): PortfolioNewsSummaryResponse | null {
	const topTickers = tickerSummaries
		.map((item) => {
			const ticker = normalizeTicker(item.ticker);
			const summary = item.summary.trim();
			if (!ticker || !summary) {
				return null;
			}

			return {
				ticker,
				weight_pct: 0,
				chapters: [
					{
						headline: item.headline?.trim() || `${ticker} news`,
						paragraph: summary,
						tickers: [ticker],
					},
				],
			};
		})
		.filter((item) => item !== null);

	if (topTickers.length === 0) {
		return null;
	}

	return {
		has_news: true,
		macros: [],
		top_tickers: topTickers,
	};
}

function normalizeSnapshotForStorage(input: unknown): PortfolioNewsSnapshot {
	const snapshot = PortfolioNewsSnapshotSchema.parse(input);
	const normalizedSnapshot = {
		...snapshot,
		key: normalizeSnapshotKey(snapshot.key),
		summary:
			snapshot.summary ?? summaryFromTickerSummaries(snapshot.ticker_summaries),
	};
	return PortfolioNewsSnapshotSchema.parse(normalizedSnapshot);
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

export async function loadPortfolioNewsSnapshot(
	store: BackendStore,
	key = DEFAULT_SNAPSHOT_KEY,
): Promise<PortfolioNewsSnapshot | null> {
	const normalizedKey = normalizeSnapshotKey(key);
	const rows = await store.loadNews(snapshotStorageKey(normalizedKey));
	const snapshotRow = rows.find(
		(row) => row.ticker === PORTFOLIO_NEWS_CACHE_TICKER,
	);
	if (!snapshotRow) {
		return null;
	}

	const parsedSnapshot = PortfolioNewsSnapshotSchema.safeParse({
		key: normalizedKey,
		...snapshotRow.row,
	});
	return parsedSnapshot.success ? parsedSnapshot.data : null;
}

export async function savePortfolioNewsSnapshot(
	store: BackendStore,
	input: unknown,
): Promise<PortfolioNewsSnapshot> {
	const normalizedSnapshot = normalizeSnapshotForStorage(input);
	await store.saveNews(
		[snapshotToRow(normalizedSnapshot)],
		snapshotStorageKey(normalizedSnapshot.key),
	);
	return normalizedSnapshot;
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
