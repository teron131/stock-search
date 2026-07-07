/** Compose ticker news fetch modes from source, selection, and optional LLM stages. */

import { webloader } from "llm-harness-js/tools/web";

import { MemoryCache } from "../cache.js";
import type {
	NewsAnalysis,
	NewsArticle,
	PortfolioNewsSummaryRequestArticle,
	PortfolioNewsSummaryRequestRow,
	PortfolioNewsSummaryResponse,
} from "../models/schemas.js";
import { NewsArticleSchema } from "../models/schemas.js";
import { normalizeTicker } from "../utils.js";
import {
	type AnalysisDeps,
	analyzeNews,
	fallbackAnalysisFromProviders,
} from "./pipeline/analysis.js";

export {
	PROVIDER_RATE_LIMITERS,
	PROVIDER_RATE_LIMITS,
	type ProviderRateLimit,
	ProviderRequestLimiter,
} from "./pipeline/sources.js";

import {
	buildNewsTickerIdentity,
	type NewsTickerIdentity,
	resolveTickerIdentityFromYahoo,
} from "./pipeline/identity.js";

export {
	buildNewsTickerIdentity,
	type NewsTickerIdentity,
} from "./pipeline/identity.js";

import {
	balanceDomains,
	FALLBACK_SUMMARIES,
	finalizeNewsFeed,
	isEnglishNewsItem,
	isNewsItemWithinRetention,
	rankNewsCandidates,
} from "./pipeline/selection.js";

export {
	balanceDomains,
	dedupeNews,
	FALLBACK_SUMMARIES,
	finalizeNewsFeed,
	isEnglishNewsItem,
	isNewsItemWithinRetention,
	rankNewsCandidates,
} from "./pipeline/selection.js";

import { fetchRawNewsFromSources } from "./pipeline/sources.js";
import {
	type PortfolioSummaryDeps,
	summarizePortfolioNews,
} from "./pipeline/summarization.js";

const FAST_LLM = process.env.FAST_LLM;
const QUALITY_LLM = process.env.QUALITY_LLM;
const MAX_NEWS_ANALYSIS_CANDIDATES = 25;
const MAX_RAW_FAST_NEWS_CANDIDATES = 25;
const MAX_RAW_FAST_NEWS_SUMMARY_CHARS = 700;
const MAX_RAW_FAST_NEWS_CONTENT_CHARS = 1_200;
const DEFAULT_NEWS_DAYS = 3;
const NEWS_FETCH_MODES = ["raw-fast", "analyzed-slow"] as const;

export type NewsFetchMode = (typeof NEWS_FETCH_MODES)[number];

export const ANALYSIS_CACHE = new MemoryCache<NewsAnalysis>({
	staleSeconds: 30 * 24 * 60 * 60,
});

export type NewsFetchOptions = {
	nDays?: number;
	maxResults?: number;
	mode?: NewsFetchMode;
	tickerIdentity?: NewsTickerIdentity;
	resolveIdentity?: boolean;
};

type NewsPipelineOptions = Omit<NewsFetchOptions, "mode">;

type NewsPipelineContext = {
	ticker: string;
	nDays: number;
	maxResults: number;
	tickerIdentity: NewsTickerIdentity;
};

export const newsRuntime = {
	analyzeNews: (
		ticker: string,
		newsList: NewsArticle[],
		tickerIdentity?: NewsTickerIdentity,
	) => analyzeNewsAsync(ticker, newsList, tickerIdentity),
};

export type NewsItem = NewsArticle;

export async function getNewsAsync(
	tickerInput: string,
	options: NewsFetchOptions = {},
): Promise<NewsArticle[]> {
	const mode = options.mode ?? "raw-fast";
	if (mode === "analyzed-slow") {
		return getAnalyzedSlowNewsAsync(tickerInput, options);
	}
	return getRawFastNewsAsync(tickerInput, options);
}

export function getNews(
	ticker: string,
	nDays = DEFAULT_NEWS_DAYS,
	maxResults = 10,
): Promise<NewsArticle[]> {
	return getNewsAsync(ticker, { nDays, maxResults });
}

export async function getRawFastNewsAsync(
	tickerInput: string,
	options: NewsPipelineOptions = {},
): Promise<NewsArticle[]> {
	const context = await buildNewsPipelineContext(tickerInput, options);
	if (!context) {
		return [];
	}
	const rawNewsList = await fetchRawNewsFromSources(context);
	const candidates = sortNewsCandidatesByMetadata(rawNewsList, {
		tickerIdentity: context.tickerIdentity,
		candidateLimit: MAX_RAW_FAST_NEWS_CANDIDATES,
	});
	return buildRawFastNews({
		newsList: candidates,
		nDays: context.nDays,
		maxResults: context.maxResults,
	});
}

export async function getAnalyzedSlowNewsAsync(
	tickerInput: string,
	options: NewsPipelineOptions = {},
): Promise<NewsArticle[]> {
	const context = await buildNewsPipelineContext(tickerInput, options);
	if (!context) {
		return [];
	}
	const rawNewsList = await fetchRawNewsFromSources(context);
	const candidates = sortNewsCandidatesByMetadata(rawNewsList, {
		tickerIdentity: context.tickerIdentity,
		candidateLimit: MAX_NEWS_ANALYSIS_CANDIDATES,
	});
	const newsAnalysisList = await labelNewsWithLlm(context, candidates);
	const analyzedNewsList = candidates.map((news, index) =>
		NewsArticleSchema.parse({
			...news,
			...newsAnalysisList[index],
		}),
	);
	return finalizeNewsFeed(balanceDomains(analyzedNewsList), {
		retentionDays: context.nDays,
	}).slice(0, context.maxResults);
}

export async function analyzeNewsAsync(
	ticker: string,
	newsList: NewsArticle[],
	tickerIdentity: NewsTickerIdentity = buildNewsTickerIdentity(ticker),
): Promise<NewsAnalysis[]> {
	return analyzeNews({
		tickerIdentity,
		newsList,
		deps: await buildAnalysisDeps(),
		analysisCache: ANALYSIS_CACHE,
		qualityModel: QUALITY_LLM,
		fastModel: FAST_LLM,
	});
}

export async function buildPortfolioNewsSummary(
	rows: PortfolioNewsSummaryRequestRow[],
	items: PortfolioNewsSummaryRequestArticle[],
): Promise<PortfolioNewsSummaryResponse> {
	return summarizePortfolioNews({
		rows,
		items,
		deps: await buildSummaryDeps(),
		fastModel: FAST_LLM,
	});
}

async function loadChatOpenAI(): Promise<
	AnalysisDeps["chatOpenAI"] | undefined
> {
	try {
		const { ChatOpenAI } = await import("llm-harness-js/clients");
		return ChatOpenAI;
	} catch {
		return undefined;
	}
}

async function buildAnalysisDeps(): Promise<AnalysisDeps> {
	return {
		chatOpenAI: QUALITY_LLM || FAST_LLM ? await loadChatOpenAI() : undefined,
		webloader,
	};
}

async function buildSummaryDeps(): Promise<PortfolioSummaryDeps> {
	return {
		chatOpenAI: FAST_LLM ? await loadChatOpenAI() : undefined,
	};
}

async function buildNewsPipelineContext(
	tickerInput: string,
	options: NewsPipelineOptions = {},
): Promise<NewsPipelineContext | null> {
	const ticker = normalizeTicker(tickerInput);
	if (!ticker) {
		return null;
	}
	const nDays = options.nDays ?? DEFAULT_NEWS_DAYS;
	const maxResults = Number.isFinite(options.maxResults)
		? Math.max(0, Math.floor(options.maxResults ?? 0))
		: 10;
	if (maxResults === 0) {
		return null;
	}

	let tickerIdentity = options.tickerIdentity
		? buildNewsTickerIdentity(
				options.tickerIdentity.ticker || ticker,
				options.tickerIdentity.companyName,
			)
		: buildNewsTickerIdentity(ticker);
	if (!options.tickerIdentity && options.resolveIdentity) {
		try {
			tickerIdentity = await resolveTickerIdentityFromYahoo(ticker);
		} catch {
			tickerIdentity = buildNewsTickerIdentity(ticker);
		}
	}

	return {
		ticker,
		nDays,
		maxResults,
		tickerIdentity,
	};
}

function sortNewsCandidatesByMetadata(
	rawNewsList: NewsArticle[],
	{
		tickerIdentity,
		candidateLimit,
	}: {
		tickerIdentity: NewsTickerIdentity;
		candidateLimit: number;
	},
): NewsArticle[] {
	const candidateCount = Math.min(candidateLimit, rawNewsList.length);
	return rankNewsCandidates(tickerIdentity, rawNewsList).slice(
		0,
		candidateCount,
	);
}

async function labelNewsWithLlm(
	context: NewsPipelineContext,
	newsList: NewsArticle[],
): Promise<NewsAnalysis[]> {
	try {
		return await newsRuntime.analyzeNews(
			context.ticker,
			newsList,
			context.tickerIdentity,
		);
	} catch {
		return fallbackAnalysisFromProviders(newsList);
	}
}

function normalizeRawFastNewsText(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function trimRawFastNewsText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars).trimEnd()}...`;
}

function providerSummaryForRawFastNews(news: NewsArticle): string {
	const summary = normalizeRawFastNewsText(news.summary ?? "");
	if (!summary) {
		return "";
	}
	for (const prefix of FALLBACK_SUMMARIES) {
		if (summary === prefix) {
			return "";
		}
		if (summary.startsWith(`${prefix} `)) {
			return trimRawFastNewsText(
				summary.slice(prefix.length).trim(),
				MAX_RAW_FAST_NEWS_SUMMARY_CHARS,
			);
		}
	}
	return trimRawFastNewsText(summary, MAX_RAW_FAST_NEWS_SUMMARY_CHARS);
}

function isRawFastNewsUrl(url: string): boolean {
	return !/consent|privacy|cookie/i.test(url);
}

async function attachRawFastContentExcerpts(
	newsList: NewsArticle[],
): Promise<NewsArticle[]> {
	let contentList: Array<string | null | undefined>;
	try {
		contentList = await webloader(newsList.map((news) => news.url));
	} catch {
		contentList = newsList.map(() => null);
	}
	return newsList.map((news, index) => {
		const content = contentList[index];
		const contentExcerpt =
			typeof content === "string" && content.trim()
				? trimRawFastNewsText(
						normalizeRawFastNewsText(content),
						MAX_RAW_FAST_NEWS_CONTENT_CHARS,
					)
				: null;
		return NewsArticleSchema.parse({
			...news,
			summary: providerSummaryForRawFastNews(news),
			content_excerpt: contentExcerpt,
		});
	});
}

async function buildRawFastNews({
	newsList,
	nDays,
	maxResults,
}: {
	newsList: NewsArticle[];
	nDays: number;
	maxResults: number;
}): Promise<NewsArticle[]> {
	const candidates = balanceDomains(
		newsList.filter(
			(news) =>
				isRawFastNewsUrl(news.url) &&
				isEnglishNewsItem(news) &&
				isNewsItemWithinRetention(news, { retentionDays: nDays }),
		),
	).slice(0, maxResults);
	return attachRawFastContentExcerpts(candidates);
}
