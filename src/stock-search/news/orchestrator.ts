import { ChatOpenAI } from "llm-harness-js/clients";
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
} from "./orchestrator/analysis.js";

export {
	PROVIDER_RATE_LIMITERS,
	PROVIDER_RATE_LIMITS,
	type ProviderRateLimit,
	ProviderRequestLimiter,
} from "./orchestrator/fetch.js";

import {
	buildNewsTickerIdentity,
	type NewsTickerIdentity,
	resolveTickerIdentityFromYahoo,
} from "./orchestrator/identity.js";

export {
	buildNewsTickerIdentity,
	type NewsTickerIdentity,
} from "./orchestrator/identity.js";

import {
	balanceDomains,
	finalizeNewsFeed,
	rankNewsCandidates,
} from "./orchestrator/router.js";

export {
	balanceDomains,
	dedupeNews,
	FALLBACK_SUMMARIES,
	finalizeNewsFeed,
	isEnglishNewsItem,
	isNewsItemWithinRetention,
	rankNewsCandidates,
} from "./orchestrator/router.js";

import {
	type PortfolioSummaryDeps,
	summarizePortfolioNews,
} from "./orchestrator/portfolio-summary.js";
import { buildRawFastNews } from "./orchestrator/raw-fast.js";
import { fetchRawNewsFromSources } from "./orchestrator/sources.js";

const FAST_LLM = process.env.FAST_LLM;
const QUALITY_LLM = process.env.QUALITY_LLM;
const MAX_NEWS_ANALYSIS_CANDIDATES = 25;
const MAX_RAW_FAST_NEWS_CANDIDATES = 25;
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

export const newsPipelineDeps = {
	chatOpenAI: ChatOpenAI,
	webloader,
	resolveTickerIdentity: resolveTickerIdentityFromYahoo,
} satisfies AnalysisDeps &
	PortfolioSummaryDeps & {
		resolveTickerIdentity: (ticker: string) => Promise<NewsTickerIdentity>;
	};

export const newsRuntime = {
	analyzeNews: (
		ticker: string,
		newsList: NewsArticle[],
		tickerIdentity?: NewsTickerIdentity,
	) => analyzeNewsAsync(ticker, newsList, tickerIdentity),
};

export type NewsItem = NewsArticle;

export async function analyzeNewsAsync(
	ticker: string,
	newsList: NewsArticle[],
	tickerIdentity: NewsTickerIdentity = buildNewsTickerIdentity(ticker),
): Promise<NewsAnalysis[]> {
	return analyzeNews({
		tickerIdentity,
		newsList,
		deps: newsPipelineDeps,
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
		deps: newsPipelineDeps,
		fastModel: FAST_LLM,
	});
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
			tickerIdentity = await newsPipelineDeps.resolveTickerIdentity(ticker);
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
		maxResults,
		candidateLimit,
	}: {
		tickerIdentity: NewsTickerIdentity;
		maxResults: number;
		candidateLimit: number;
	},
): NewsArticle[] {
	const candidateCount = Math.max(
		maxResults,
		Math.min(candidateLimit, rawNewsList.length),
	);
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

function mergeNewsLabels(
	newsList: NewsArticle[],
	newsAnalysisList: NewsAnalysis[],
): NewsArticle[] {
	return newsList.map((news, index) =>
		NewsArticleSchema.parse({
			...news,
			...newsAnalysisList[index],
		}),
	);
}

function filterAndSortAnalyzedNews(
	newsList: NewsArticle[],
	{ nDays, maxResults }: { nDays: number; maxResults: number },
): NewsArticle[] {
	return finalizeNewsFeed(balanceDomains(newsList), {
		retentionDays: nDays,
	}).slice(0, maxResults);
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
		maxResults: context.maxResults,
		candidateLimit: MAX_RAW_FAST_NEWS_CANDIDATES,
	});
	return buildRawFastNews({
		newsList: candidates,
		nDays: context.nDays,
		maxResults: context.maxResults,
		deps: newsPipelineDeps,
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
		maxResults: context.maxResults,
		candidateLimit: MAX_NEWS_ANALYSIS_CANDIDATES,
	});
	const newsAnalysisList = await labelNewsWithLlm(context, candidates);
	return filterAndSortAnalyzedNews(
		mergeNewsLabels(candidates, newsAnalysisList),
		{
			nDays: context.nDays,
			maxResults: context.maxResults,
		},
	);
}

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
