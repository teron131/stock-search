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
import {
	createHttpClient,
	fetchProviderBatch,
	hasEnvValue,
	type ProviderSpec,
} from "./orchestrator/fetch.js";

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
	dedupeNews,
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
import * as newsProviders from "./providers/index.js";

const FAST_LLM = process.env.FAST_LLM;
const QUALITY_LLM = process.env.QUALITY_LLM;
const MAX_NEWS_ANALYSIS_CANDIDATES = 25;
const DEFAULT_NEWS_DAYS = 3;

export const ANALYSIS_CACHE = new MemoryCache<NewsAnalysis>({
	staleSeconds: 30 * 24 * 60 * 60,
});

export type NewsFetchOptions = {
	nDays?: number;
	maxResults?: number;
	tickerIdentity?: NewsTickerIdentity;
	resolveIdentity?: boolean;
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

export async function getNewsAsync(
	tickerInput: string,
	options: NewsFetchOptions = {},
): Promise<NewsArticle[]> {
	const ticker = normalizeTicker(tickerInput);
	if (!ticker) {
		return [];
	}
	const nDays = options.nDays ?? DEFAULT_NEWS_DAYS;
	const boundedMaxResults = Number.isFinite(options.maxResults)
		? Math.max(0, Math.floor(options.maxResults ?? 0))
		: 10;
	if (boundedMaxResults === 0) {
		return [];
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
	const providerQuery = tickerIdentity.companyName
		? tickerIdentity.label
		: tickerIdentity.ticker;
	const client = createHttpClient();
	const primaryProviderSpecs: ProviderSpec[] = [];
	if (hasEnvValue(process.env.NEWSDATA_API_KEY)) {
		primaryProviderSpecs.push([
			"newsdata",
			() =>
				newsProviders.getNewsNewsDataAsync({
					query: providerQuery,
					client,
				}),
		]);
	}
	if (hasEnvValue(process.env.MASSIVE_API_KEY)) {
		primaryProviderSpecs.push([
			"massive",
			() =>
				newsProviders.getNewsMassiveAsync({
					ticker,
					nDays,
					client,
				}),
		]);
	}
	if (hasEnvValue(process.env.NEWS_API_KEY)) {
		primaryProviderSpecs.push([
			"newsapi",
			() =>
				newsProviders.getNewsNewsApiAsync({
					query: providerQuery,
					nDays,
					client,
				}),
		]);
	}
	primaryProviderSpecs.push([
		"yfinance",
		() =>
			newsProviders.getNewsYahooFinance({
				ticker,
			}),
	]);

	let rawNewsList = dedupeNews(await fetchProviderBatch(primaryProviderSpecs));
	const primaryAnalysisLimit = Math.max(
		boundedMaxResults,
		Math.min(MAX_NEWS_ANALYSIS_CANDIDATES, rawNewsList.length),
	);

	if (
		rawNewsList.length < primaryAnalysisLimit &&
		hasEnvValue(process.env.EXA_API_KEY)
	) {
		const exaNewsList = await fetchProviderBatch([
			[
				"exa",
				() =>
					newsProviders.getNewsExaAsync({
						query: providerQuery,
						nDays,
						client,
					}),
			],
		]);
		rawNewsList = dedupeNews([...rawNewsList, ...exaNewsList]);
	}

	const analysisLimit = Math.max(
		boundedMaxResults,
		Math.min(MAX_NEWS_ANALYSIS_CANDIDATES, rawNewsList.length),
	);
	rawNewsList = rankNewsCandidates(tickerIdentity, rawNewsList).slice(
		0,
		analysisLimit,
	);

	let newsAnalysisList: NewsAnalysis[];
	try {
		newsAnalysisList = await newsRuntime.analyzeNews(
			ticker,
			rawNewsList,
			tickerIdentity,
		);
	} catch {
		newsAnalysisList = fallbackAnalysisFromProviders(rawNewsList);
	}
	const newsList = rawNewsList.map((news, index) =>
		NewsArticleSchema.parse({
			...news,
			...newsAnalysisList[index],
		}),
	);

	return finalizeNewsFeed(balanceDomains(newsList), {
		retentionDays: nDays,
	}).slice(0, boundedMaxResults);
}

export function getNews(
	ticker: string,
	nDays = DEFAULT_NEWS_DAYS,
	maxResults = 10,
): Promise<NewsArticle[]> {
	return getNewsAsync(ticker, { nDays, maxResults });
}
