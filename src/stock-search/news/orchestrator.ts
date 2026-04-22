import * as openAiClients from "../../../../llm-harness-js/src/clients/openai.js";

import { TieredCache } from "../cache.js";
import {
	newsAnalysisSchema,
	newsArticleSchema,
	portfolioNewsChapterSchema,
	portfolioNewsSummaryModelSchema,
	portfolioNewsSummaryRequestArticleSchema,
	portfolioNewsSummaryRequestRowSchema,
	portfolioNewsSummaryResponseSchema,
	type NewsAnalysis,
	type NewsArticle,
	type PortfolioNewsChapter,
	type PortfolioNewsSummaryRequestArticle,
	type PortfolioNewsSummaryRequestRow,
	type PortfolioNewsSummaryResponse,
	type PortfolioNewsSummaryResponseTicker,
	type PortfolioTickerNewsChapters,
} from "../models/schemas.js";
import {
	NEWS_ANALYSIS_PROMPT,
	PORTFOLIO_NEWS_SUMMARY_PROMPT,
} from "../prompts.js";
import { normalizeTicker } from "../utils.js";
import * as newsProviders from "./providers/index.js";
import { DAY_IN_MS, parseDateString } from "./providers/shared.js";
import * as webloaderModule from "./webloader.js";

const FAST_LLM = process.env.FAST_LLM;
const MAX_ANALYSIS_WORKERS = 10;
const MAX_PORTFOLIO_SUMMARY_TICKERS = 5;
const MAX_PORTFOLIO_SUMMARY_ITEMS = 3;
const MAX_PORTFOLIO_SUMMARY_ARTICLES = 18;
const MAX_PORTFOLIO_SUMMARY_MACRO_ITEMS = 2;
const MAX_NEWS_FETCH_RETENTION_DAYS = 3;
const MAX_NEWS_PUBLISHED_RETENTION_DAYS = 3;
const THIN_COVERAGE_HEADLINE = "Coverage remains thin";
const THIN_COVERAGE_PARAGRAPH =
	"Current feed does not surface a clear ticker-specific development yet.";
const MACRO_FALLBACK_CATEGORY_SCORES: Record<string, number> = {
	macro_economics: 2,
	market_news: 1,
};
const SUMMARY_HEADLINE_BLACKLIST = new Set([
	"theme",
	"takeaway",
	"setup",
	"weight",
	"backdrop",
	"cross-ticker",
	"company update",
	"news theme",
	"portfolio focus",
]);
export const FALLBACK_SUMMARIES = ["[TRUNCATED]", "[FAILED TO FETCH]"] as const;
const RELEVANCY_ORDER: Record<NewsArticle["relevancy"], number> = {
	high: 0,
	medium: 1,
	low: 2,
};
const MAX_NON_ASCII_LATIN_RATIO = 0.1;
const MIN_NON_ASCII_LATIN_LETTERS = 5;

export const ANALYSIS_CACHE = new TieredCache<NewsAnalysis>({
	ttlSeconds: 7 * 24 * 60 * 60,
	staleSeconds: 30 * 24 * 60 * 60,
	failureCooldownSeconds: 10 * 60,
});

export const newsPipelineDeps = {
	chatOpenAI: openAiClients.ChatOpenAI,
	webloader: webloaderModule.webloader,
};

export const newsRuntime = {
	analyzeNews: (ticker: string, newsList: NewsArticle[]) =>
		_analyzeNews(ticker, newsList),
};

export type ProviderRateLimit = {
	maxRequests: number;
	windowMs: number;
};

export class ProviderRequestLimiter {
	private requestTimes: Date[] = [];

	constructor(private readonly limit: ProviderRateLimit) {}

	acquire(now = new Date()): boolean {
		const cutoff = now.getTime() - this.limit.windowMs;
		this.requestTimes = this.requestTimes.filter(
			(requestTime) => requestTime.getTime() > cutoff,
		);
		if (this.requestTimes.length >= this.limit.maxRequests) {
			return false;
		}
		this.requestTimes.push(now);
		return true;
	}
}

export const PROVIDER_RATE_LIMITS: Record<string, ProviderRateLimit> = {
	massive: {
		maxRequests: 5,
		windowMs: 60 * 1000,
	},
	newsapi: {
		maxRequests: 100,
		windowMs: 24 * 60 * 60 * 1000,
	},
	newsdata: {
		maxRequests: 200,
		windowMs: 24 * 60 * 60 * 1000,
	},
};

export const PROVIDER_RATE_LIMITERS = new Map(
	Object.entries(PROVIDER_RATE_LIMITS).map(([providerName, limit]) => [
		providerName,
		new ProviderRequestLimiter(limit),
	]),
);

type ProviderSpec = readonly [string, () => Promise<NewsArticle[]>];

type ProviderBatchItem = {
	index: number;
	cacheKey: string;
	news: NewsArticle;
};

type ReadableAnalysisItem = ProviderBatchItem & {
	content: string;
};

type HttpResponse = {
	ok?: boolean;
	json(): Promise<unknown>;
	raise_for_status?: () => void;
};

type HttpClient = {
	get(input: {
		url: string;
		params: Record<string, string>;
	}): Promise<HttpResponse>;
	post(input: {
		url: string;
		json: Record<string, unknown>;
		headers: Record<string, string>;
	}): Promise<HttpResponse>;
};

export type NewsItem = NewsArticle;

function formatPrompt(
	template: string,
	values: Record<string, string>,
): string {
	return template.replace(/\{([a-z_]+)\}/gi, (match, key) =>
		Object.hasOwn(values, key) ? values[key] : match,
	);
}

function normalizeUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		const filteredParams = [...url.searchParams.entries()].filter(
			([key]) => !key.startsWith("utm_"),
		);
		const query = new URLSearchParams(filteredParams).toString();
		const normalizedPath = url.pathname.replace(/\/+$/, "");
		return `${url.protocol}//${url.host.toLowerCase()}${normalizedPath}${
			query ? `?${query}` : ""
		}`;
	} catch {
		return rawUrl.trim().toLowerCase();
	}
}

function extractDomain(rawUrl: string): string {
	try {
		return new URL(normalizeUrl(rawUrl)).hostname.replace(/^www\./, "");
	} catch {
		return rawUrl;
	}
}

function createHttpResponse(response: Response): HttpResponse {
	return {
		ok: response.ok,
		async json(): Promise<unknown> {
			return response.json();
		},
		raise_for_status(): void {
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
		},
	};
}

function createHttpClient(): HttpClient {
	return {
		async get({
			url,
			params,
		}: {
			url: string;
			params: Record<string, string>;
		}): Promise<HttpResponse> {
			const targetUrl = `${url}?${new URLSearchParams(params).toString()}`;
			return createHttpResponse(
				await fetch(targetUrl, {
					headers: {
						"user-agent": "Mozilla/5.0",
					},
				}),
			);
		},
		async post({
			url,
			json,
			headers,
		}: {
			url: string;
			json: Record<string, unknown>;
			headers: Record<string, string>;
		}): Promise<HttpResponse> {
			return createHttpResponse(
				await fetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify(json),
				}),
			);
		},
	};
}

export function _dedupeNews(items: NewsArticle[]): NewsArticle[] {
	const seen = new Map<string, NewsArticle>();
	for (const item of items) {
		const key = item.url ? normalizeUrl(item.url) : item.title ?? "";
		if (!seen.has(key)) {
			seen.set(key, item);
		}
	}
	return [...seen.values()];
}

function _normalizeNewsMetadata(
	metadata: NewsArticle["metadata"] | Record<string, unknown> | null | undefined,
): Record<string, string> {
	if (!metadata) {
		return {};
	}

	const normalizedMetadata: Record<string, string> = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (typeof value === "string") {
			normalizedMetadata[key] = value;
		}
	}
	return normalizedMetadata;
}

function _parseRetentionDatetime(value: string | null | undefined): Date | null {
	return parseDateString(value ?? undefined);
}

export function _isNewsItemWithinRetention(
	news: NewsArticle,
	{ now = new Date() }: { now?: Date } = {},
): boolean {
	const metadata = _normalizeNewsMetadata(news.metadata);
	const maxFetchAgeMs = MAX_NEWS_FETCH_RETENTION_DAYS * DAY_IN_MS;
	const maxPublishedAgeMs = MAX_NEWS_PUBLISHED_RETENTION_DAYS * DAY_IN_MS;

	const fetchedAt = _parseRetentionDatetime(metadata.fetched_at);
	if (fetchedAt && now.getTime() - fetchedAt.getTime() > maxFetchAgeMs) {
		return false;
	}

	if (typeof news.days_ago === "number") {
		return news.days_ago <= MAX_NEWS_PUBLISHED_RETENTION_DAYS;
	}

	const publishedAt = _parseRetentionDatetime(metadata.published_at);
	if (publishedAt) {
		return now.getTime() - publishedAt.getTime() <= maxPublishedAgeMs;
	}

	const publishedDate = _parseRetentionDatetime(news.date);
	if (publishedDate) {
		return now.getTime() - publishedDate.getTime() <= maxPublishedAgeMs;
	}

	return fetchedAt !== null;
}

export function _isEnglishNewsItem(news: NewsArticle): boolean {
	const text = [news.title, news.summary].filter(Boolean).join(" ").trim();
	if (!text) {
		return true;
	}

	let letterCount = 0;
	let nonAsciiLatinLetters = 0;
	let nonLatinLetters = 0;
	for (const character of text) {
		if (!/\p{L}/u.test(character)) {
			continue;
		}
		letterCount += 1;
		if (character.codePointAt(0)! <= 127) {
			continue;
		}
		if (/\p{Script=Latin}/u.test(character)) {
			nonAsciiLatinLetters += 1;
			continue;
		}
		nonLatinLetters += 1;
	}

	if (letterCount === 0) {
		return true;
	}
	if (nonLatinLetters > 0) {
		return false;
	}
	if (nonAsciiLatinLetters < MIN_NON_ASCII_LATIN_LETTERS) {
		return true;
	}

	return nonAsciiLatinLetters / letterCount <= MAX_NON_ASCII_LATIN_RATIO;
}

export function _balanceDomains(items: NewsArticle[]): NewsArticle[] {
	if (items.length === 0) {
		return [];
	}

	const domains = items
		.map((item) => (item.url ? extractDomain(item.url) : ""))
		.filter(Boolean);
	if (domains.length === 0) {
		return items;
	}

	const domainCap = Math.ceil(items.length / new Set(domains).size);
	const counts = new Map<string, number>();
	const kept: NewsArticle[] = [];
	for (const item of items) {
		const domain = item.url ? extractDomain(item.url) : "";
		const count = counts.get(domain) ?? 0;
		if (!domain || count < domainCap) {
			if (domain) {
				counts.set(domain, count + 1);
			}
			kept.push(item);
		}
	}
	return kept;
}

function _splitCachedAnalysis(
	newsList: NewsArticle[],
): {
	results: NewsAnalysis[];
	cacheHits: number;
	uncachedItems: ProviderBatchItem[];
} {
	const failed = newsAnalysisSchema.parse({
		summary: FALLBACK_SUMMARIES[1],
	});
	const results = newsList.map(() => ({ ...failed }));
	let cacheHits = 0;
	const uncachedItems: ProviderBatchItem[] = [];

	newsList.forEach((news, index) => {
		const cacheKey = normalizeUrl(news.url);
		const cached = ANALYSIS_CACHE.getStale(cacheKey);
		if (cached) {
			results[index] = cached;
			cacheHits += 1;
			return;
		}
		uncachedItems.push({ index, cacheKey, news });
	});

	return {
		results,
		cacheHits,
		uncachedItems,
	};
}

async function _buildAnalysisBatch(
	ticker: string,
	uncachedItems: ProviderBatchItem[],
): Promise<{
	readableItems: ReadableAnalysisItem[];
	prompts: string[];
}> {
	const contentList = await newsPipelineDeps.webloader(
		uncachedItems.map((item) => item.news.url),
	);

	const readableItems = uncachedItems
		.map((item, index) => ({
			...item,
			content: contentList[index],
		}))
		.filter(
			(item): item is ReadableAnalysisItem =>
				typeof item.content === "string" && item.content.trim().length > 0,
		);

	return {
		readableItems,
		prompts: readableItems.map(({ news, content }) =>
			formatPrompt(NEWS_ANALYSIS_PROMPT, {
				ticker,
				title: news.title ?? "",
				content,
			}),
		),
	};
}

async function invokeStructuredBatch<T>(
	model: { invoke(input: string): Promise<unknown> | unknown },
	prompts: string[],
	parse: (value: unknown) => T,
): Promise<T[]> {
	const responses: T[] = [];
	for (let index = 0; index < prompts.length; index += MAX_ANALYSIS_WORKERS) {
		const batch = prompts.slice(index, index + MAX_ANALYSIS_WORKERS);
		const batchResponses = await Promise.all(
			batch.map(async (prompt) => parse(await model.invoke(prompt))),
		);
		responses.push(...batchResponses);
	}
	return responses;
}

function _mergeAnalysisResults(
	results: NewsAnalysis[],
	readableItems: ReadableAnalysisItem[],
	responses: NewsAnalysis[],
): NewsAnalysis[] {
	readableItems.forEach((item, index) => {
		const analysis = responses[index];
		results[item.index] = analysis;
		if (!FALLBACK_SUMMARIES.some((prefix) => analysis.summary.startsWith(prefix))) {
			ANALYSIS_CACHE.set(item.cacheKey, analysis);
		}
	});
	return results;
}

function _rateLimitProviderSpecs(
	_ticker: string,
	providerSpecs: readonly ProviderSpec[],
): {
	allowedSpecs: ProviderSpec[];
	skippedCounts: Record<string, number>;
} {
	const allowedSpecs: ProviderSpec[] = [];
	const skippedCounts: Record<string, number> = {};
	for (const [providerName, providerCall] of providerSpecs) {
		const limiter = PROVIDER_RATE_LIMITERS.get(providerName);
		if (!limiter || limiter.acquire()) {
			allowedSpecs.push([providerName, providerCall]);
			continue;
		}
		skippedCounts[providerName] = 0;
	}
	return {
		allowedSpecs,
		skippedCounts,
	};
}

function _collectProviderResults(
	providerSpecs: readonly ProviderSpec[],
	providerResults: PromiseSettledResult<NewsArticle[]>[],
): {
	rawNewsList: NewsArticle[];
	providerCounts: Record<string, number>;
} {
	const rawNewsList: NewsArticle[] = [];
	const providerCounts: Record<string, number> = {};
	providerResults.forEach((result, index) => {
		const [providerName] = providerSpecs[index];
		if (result.status === "rejected") {
			providerCounts[providerName] = 0;
			return;
		}
		providerCounts[providerName] = result.value.length;
		rawNewsList.push(...result.value);
	});
	return {
		rawNewsList,
		providerCounts,
	};
}

async function _fetchProviderBatch(
	ticker: string,
	providerSpecs: readonly ProviderSpec[],
): Promise<{
	rawNewsList: NewsArticle[];
	providerCounts: Record<string, number>;
}> {
	const { allowedSpecs, skippedCounts } = _rateLimitProviderSpecs(
		ticker,
		providerSpecs,
	);
	if (allowedSpecs.length === 0) {
		return {
			rawNewsList: [],
			providerCounts: skippedCounts,
		};
	}

	const providerResults = await Promise.allSettled(
		allowedSpecs.map(([, providerCall]) => providerCall()),
	);
	const { rawNewsList, providerCounts } = _collectProviderResults(
		allowedSpecs,
		providerResults,
	);

	return {
		rawNewsList,
		providerCounts: {
			...providerCounts,
			...skippedCounts,
		},
	};
}

export function _finalizeNewsFeed(newsList: NewsArticle[]): NewsArticle[] {
	const filteredNewsList = newsList.filter(
		(news) =>
			!FALLBACK_SUMMARIES.some((prefix) => news.summary.startsWith(prefix)) &&
			news.relevancy !== "low" &&
			_isEnglishNewsItem(news) &&
			_isNewsItemWithinRetention(news),
	);

	return filteredNewsList.sort((left, right) => {
		const leftDaysAgo =
			typeof left.days_ago === "number" ? left.days_ago : Number.POSITIVE_INFINITY;
		const rightDaysAgo =
			typeof right.days_ago === "number"
				? right.days_ago
				: Number.POSITIVE_INFINITY;
		if (leftDaysAgo !== rightDaysAgo) {
			return leftDaysAgo - rightDaysAgo;
		}
		return RELEVANCY_ORDER[left.relevancy] - RELEVANCY_ORDER[right.relevancy];
	});
}

function _fallbackAnalysisFromProviders(newsList: NewsArticle[]): NewsAnalysis[] {
	return newsList.map((news) =>
		newsAnalysisSchema.parse({
			summary: news.summary ?? "",
			relevancy: news.relevancy,
			category: news.category,
			sentiment: news.sentiment,
		}),
	);
}

export async function _analyzeNews(
	ticker: string,
	newsList: NewsArticle[],
): Promise<NewsAnalysis[]> {
	const { results, uncachedItems } = _splitCachedAnalysis(newsList);
	if (uncachedItems.length === 0) {
		return results;
	}

	const model = newsPipelineDeps
		.chatOpenAI({
			model: FAST_LLM ?? "",
			temperature: 0,
			reasoningEffort: "low",
		})
		.withStructuredOutput(newsAnalysisSchema);
	const { readableItems, prompts } = await _buildAnalysisBatch(
		ticker,
		uncachedItems,
	);
	if (readableItems.length === 0) {
		return results;
	}

	const responses = await invokeStructuredBatch(
		model,
		prompts,
		(value) => newsAnalysisSchema.parse(value),
	);
	return _mergeAnalysisResults(results, readableItems, responses);
}

function _normalizePortfolioNewsSummaryRows(
	rows: PortfolioNewsSummaryRequestRow[],
): Array<{ ticker: string; weight_pct: number }> {
	const normalizedRows: Array<{ ticker: string; weight_pct: number }> = [];
	const seenTickers = new Set<string>();

	const totalValue = rows.reduce((sum, row) => {
		const parsedRow = portfolioNewsSummaryRequestRowSchema.parse(row);
		const quantity = Number(parsedRow.quantity ?? 0);
		const total = Number(parsedRow.total ?? 0);
		if (!parsedRow.ticker || quantity <= 0 || total <= 0) {
			return sum;
		}
		return sum + total;
	}, 0);

	for (const row of rows) {
		const parsedRow = portfolioNewsSummaryRequestRowSchema.parse(row);
		const ticker = normalizeTicker(parsedRow.ticker);
		const quantity = Number(parsedRow.quantity ?? 0);
		if (!ticker || quantity <= 0 || seenTickers.has(ticker)) {
			continue;
		}

		seenTickers.add(ticker);
		let weightPct = Number(parsedRow.weight_pct ?? 0);
		if (weightPct <= 0) {
			const total = Number(parsedRow.total ?? 0);
			weightPct = totalValue > 0 && total > 0 ? (total / totalValue) * 100 : 0;
		}
		normalizedRows.push({
			ticker,
			weight_pct: weightPct,
		});
	}

	return normalizedRows.sort((left, right) => right.weight_pct - left.weight_pct);
}

function _normalizePortfolioNewsSummaryItems(
	items: PortfolioNewsSummaryRequestArticle[],
	heldTickers: Set<string>,
): Array<{
	title: string | null;
	summary: string;
	relevancy: NewsArticle["relevancy"];
	category: NewsArticle["category"];
	sentiment: NewsArticle["sentiment"];
	source_tickers: string[];
}> {
	const normalizedItems: Array<{
		title: string | null;
		summary: string;
		relevancy: NewsArticle["relevancy"];
		category: NewsArticle["category"];
		sentiment: NewsArticle["sentiment"];
		source_tickers: string[];
	}> = [];

	for (const item of items) {
		const parsedItem = portfolioNewsSummaryRequestArticleSchema.parse(item);
		const summary = parsedItem.summary.trim().replace(/\s+/g, " ");
		if (!summary) {
			continue;
		}

		const sourceTickers: string[] = [];
		const seenTickers = new Set<string>();
		for (const ticker of parsedItem.source_tickers) {
			const normalizedTicker = normalizeTicker(ticker);
			if (
				!normalizedTicker ||
				!heldTickers.has(normalizedTicker) ||
				seenTickers.has(normalizedTicker)
			) {
				continue;
			}
			seenTickers.add(normalizedTicker);
			sourceTickers.push(normalizedTicker);
		}

		normalizedItems.push({
			title: parsedItem.title?.trim() ? parsedItem.title.trim() : null,
			summary,
			relevancy: parsedItem.relevancy,
			category: parsedItem.category,
			sentiment: parsedItem.sentiment,
			source_tickers: sourceTickers,
		});
	}

	return normalizedItems.slice(0, MAX_PORTFOLIO_SUMMARY_ARTICLES);
}

function _normalizeSummaryTickers(
	tickers: string[],
	allowedTickers: Set<string>,
): string[] {
	const normalizedTickers: string[] = [];
	const seenTickers = new Set<string>();
	for (const ticker of tickers) {
		const normalizedTicker = normalizeTicker(ticker);
		if (
			!normalizedTicker ||
			!allowedTickers.has(normalizedTicker) ||
			seenTickers.has(normalizedTicker)
		) {
			continue;
		}
		seenTickers.add(normalizedTicker);
		normalizedTickers.push(normalizedTicker);
	}
	return normalizedTickers;
}

function _cleanPortfolioNewsSummaryChapters(
	chapters: PortfolioNewsChapter[],
	{
		allowedTickers,
		fallbackTickers = [],
	}: {
		allowedTickers: Set<string>;
		fallbackTickers?: string[];
	},
): PortfolioNewsChapter[] {
	const cleanedChapters: PortfolioNewsChapter[] = [];
	for (const chapter of chapters) {
		const parsedChapter = portfolioNewsChapterSchema.parse(chapter);
		const headline = parsedChapter.headline.trim().replace(/\s+/g, " ");
		const paragraph = parsedChapter.paragraph.trim().replace(/\s+/g, " ");
		if (!headline || !paragraph) {
			continue;
		}
		if (SUMMARY_HEADLINE_BLACKLIST.has(headline.toLowerCase())) {
			continue;
		}
		const tickers = _normalizeSummaryTickers(
			parsedChapter.tickers,
			allowedTickers,
		);
		cleanedChapters.push({
			headline,
			paragraph,
			tickers:
				tickers.length > 0
					? tickers
					: fallbackTickers.filter((ticker) => allowedTickers.has(ticker)),
		});
		if (cleanedChapters.length >= MAX_PORTFOLIO_SUMMARY_ITEMS) {
			break;
		}
	}
	return cleanedChapters;
}

function _fallbackChapterFromSummary({
	headline,
	paragraph,
	tickers,
}: {
	headline: string;
	paragraph: string;
	tickers: string[];
}): PortfolioNewsChapter {
	return {
		headline,
		paragraph,
		tickers,
	};
}

function _titleCaseSummaryHeadline(text: string): string {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map((word) =>
			word.length <= 3
				? word.toUpperCase()
				: `${word[0].toUpperCase()}${word.slice(1)}`,
		)
		.join(" ");
}

function _fallbackSummaryHeadline(title: string | null): string {
	if (!title) {
		return "Market thread";
	}

	let baseTitle = title.trim().replace(/\s+/g, " ");
	baseTitle = baseTitle.split("|", 1)[0];
	for (const separator of [":", ";", "-"]) {
		baseTitle = baseTitle.split(separator, 1)[0];
	}
	baseTitle = baseTitle.trim().replace(/\s+/g, " ");
	if (!baseTitle) {
		return "Market thread";
	}

	return _titleCaseSummaryHeadline(
		baseTitle.split(/\s+/).slice(0, 6).join(" "),
	);
}

function _buildPromptTopPositions(
	rows: Array<{ ticker: string; weight_pct: number }>,
): Array<{ ticker: string; priority_rank: number }> {
	return rows.map((row, index) => ({
		ticker: row.ticker,
		priority_rank: index + 1,
	}));
}

function _buildPortfolioNewsSummaryPrompt({
	heldTickers,
	topRows,
	normalizedItems,
}: {
	heldTickers: Set<string>;
	topRows: Array<{ ticker: string; weight_pct: number }>;
	normalizedItems: Array<{
		title: string | null;
		summary: string;
		relevancy: NewsArticle["relevancy"];
		category: NewsArticle["category"];
		sentiment: NewsArticle["sentiment"];
		source_tickers: string[];
	}>;
}): string {
	return formatPrompt(PORTFOLIO_NEWS_SUMMARY_PROMPT, {
		held_tickers_json: JSON.stringify([...heldTickers].sort()),
		top_positions_json: JSON.stringify(_buildPromptTopPositions(topRows)),
		news_items_json: JSON.stringify(normalizedItems),
	});
}

function _fallbackTickerChapters({
	ticker,
	normalizedItems,
}: {
	ticker: string;
	normalizedItems: Array<{ summary: string; source_tickers: string[] }>;
}): PortfolioNewsChapter[] {
	const tickerItems = normalizedItems.filter((item) =>
		item.source_tickers.includes(ticker),
	);
	if (tickerItems.length > 0) {
		return [
			_fallbackChapterFromSummary({
				headline: THIN_COVERAGE_HEADLINE,
				paragraph: tickerItems[0].summary,
				tickers: [ticker],
			}),
		];
	}

	return [
		_fallbackChapterFromSummary({
			headline: THIN_COVERAGE_HEADLINE,
			paragraph: THIN_COVERAGE_PARAGRAPH,
			tickers: [ticker],
		}),
	];
}

function _fallbackMacroChapters({
	normalizedItems,
	heldTickers,
}: {
	normalizedItems: Array<{
		title: string | null;
		summary: string;
		relevancy: NewsArticle["relevancy"];
		category: NewsArticle["category"];
		source_tickers: string[];
	}>;
	heldTickers: Set<string>;
}): PortfolioNewsChapter[] {
	const macroCandidates: Array<{
		categoryScore: number;
		relevanceScore: number;
		breadthScore: number;
		positionScore: number;
		headline: string;
		paragraph: string;
		sourceTickers: string[];
	}> = [];
	const seenSummaries = new Set<string>();

	normalizedItems.forEach((item, index) => {
		const categoryScore = MACRO_FALLBACK_CATEGORY_SCORES[item.category];
		if (categoryScore === undefined) {
			return;
		}
		if (!item.summary || seenSummaries.has(item.summary)) {
			return;
		}
		seenSummaries.add(item.summary);
		const sourceTickers = item.source_tickers.filter((ticker) =>
			heldTickers.has(ticker),
		);
		macroCandidates.push({
			categoryScore,
			relevanceScore: -RELEVANCY_ORDER[item.relevancy],
			breadthScore: sourceTickers.length,
			positionScore: -index,
			headline: _fallbackSummaryHeadline(item.title),
			paragraph: item.summary,
			sourceTickers,
		});
	});

	macroCandidates.sort((left, right) => {
		if (left.categoryScore !== right.categoryScore) {
			return right.categoryScore - left.categoryScore;
		}
		if (left.relevanceScore !== right.relevanceScore) {
			return right.relevanceScore - left.relevanceScore;
		}
		if (left.breadthScore !== right.breadthScore) {
			return right.breadthScore - left.breadthScore;
		}
		return right.positionScore - left.positionScore;
	});

	return macroCandidates
		.slice(0, MAX_PORTFOLIO_SUMMARY_MACRO_ITEMS)
		.map((candidate) =>
			_fallbackChapterFromSummary({
				headline: candidate.headline,
				paragraph: candidate.paragraph,
				tickers: candidate.sourceTickers,
			}),
		);
}

function _buildTopTickerSummary({
	row,
	summaryByTicker,
	normalizedItems,
	heldTickers,
}: {
	row: { ticker: string; weight_pct: number };
	summaryByTicker: Map<string, PortfolioTickerNewsChapters>;
	normalizedItems: Array<{ summary: string; source_tickers: string[] }>;
	heldTickers: Set<string>;
}): PortfolioNewsSummaryResponseTicker {
	const summaryEntry = summaryByTicker.get(row.ticker);
	let chapters = _cleanPortfolioNewsSummaryChapters(
		summaryEntry?.chapters ?? [],
		{
			allowedTickers: heldTickers,
			fallbackTickers: [row.ticker],
		},
	);
	if (chapters.length === 0) {
		chapters = _fallbackTickerChapters({
			ticker: row.ticker,
			normalizedItems,
		});
	}

	return {
		ticker: row.ticker,
		weight_pct: row.weight_pct,
		chapters,
	};
}

export async function summarizePortfolioNewsAsync(
	rows: PortfolioNewsSummaryRequestRow[],
	items: PortfolioNewsSummaryRequestArticle[],
): Promise<PortfolioNewsSummaryResponse> {
	const normalizedRows = _normalizePortfolioNewsSummaryRows(rows);
	if (normalizedRows.length === 0) {
		return portfolioNewsSummaryResponseSchema.parse({
			has_news: false,
		});
	}

	const topRows = normalizedRows.slice(0, MAX_PORTFOLIO_SUMMARY_TICKERS);
	const heldTickers = new Set(normalizedRows.map((row) => row.ticker));
	const normalizedItems = _normalizePortfolioNewsSummaryItems(items, heldTickers);
	if (normalizedItems.length === 0) {
		return portfolioNewsSummaryResponseSchema.parse({
			has_news: false,
		});
	}

	const prompt = _buildPortfolioNewsSummaryPrompt({
		heldTickers,
		topRows,
		normalizedItems,
	});
	const model = newsPipelineDeps
		.chatOpenAI({
			model: FAST_LLM ?? "",
			temperature: 0,
			reasoningEffort: "low",
		})
		.withStructuredOutput(portfolioNewsSummaryModelSchema);
	const summary = portfolioNewsSummaryModelSchema.parse(await model.invoke(prompt));

	let macros = _cleanPortfolioNewsSummaryChapters(summary.macros, {
		allowedTickers: heldTickers,
	});
	if (macros.length === 0) {
		macros = _fallbackMacroChapters({
			normalizedItems,
			heldTickers,
		});
	}

	const summaryByTicker = new Map(
		summary.top_tickers.map((entry) => [normalizeTicker(entry.ticker), entry]),
	);
	const topTickers = topRows.map((row) =>
		_buildTopTickerSummary({
			row,
			summaryByTicker,
			normalizedItems,
			heldTickers,
		}),
	);

	return portfolioNewsSummaryResponseSchema.parse({
		has_news: true,
		macros,
		top_tickers: topTickers,
	});
}

export const buildPortfolioNewsSummary = summarizePortfolioNewsAsync;

export async function getNewsAsync(
	tickerInput: string,
	nDays = 3,
	maxResults = 10,
): Promise<NewsArticle[]> {
	const ticker = normalizeTicker(tickerInput);
	if (!ticker) {
		return [];
	}

	const client = createHttpClient();
	const primaryProviderSpecs: readonly ProviderSpec[] = [
		[
			"newsdata",
			() =>
				newsProviders.getNewsNewsDataAsync({
					query: ticker,
					client,
				}),
		],
		[
			"massive",
			() =>
				newsProviders.getNewsMassiveAsync({
					ticker,
					nDays,
					maxResults,
					client,
				}),
		],
		[
			"newsapi",
			() =>
				newsProviders.getNewsNewsApiAsync({
					query: ticker,
					nDays,
					maxResults,
					client,
				}),
		],
		[
			"yfinance",
			() =>
				newsProviders.getNewsYahooFinance({
					ticker,
					maxResults,
				}),
		],
	];

	const primaryBatch = await _fetchProviderBatch(ticker, primaryProviderSpecs);
	let rawNewsList = _dedupeNews(primaryBatch.rawNewsList);
	const providerCounts = { ...primaryBatch.providerCounts };

	if (rawNewsList.length < maxResults) {
		const exaBatch = await _fetchProviderBatch(ticker, [
			[
				"exa",
				() =>
					newsProviders.getNewsExaAsync({
						query: ticker,
						nDays,
						maxResults,
						client,
					}),
			],
		]);
		Object.assign(providerCounts, exaBatch.providerCounts);
		rawNewsList = _dedupeNews([...rawNewsList, ...exaBatch.rawNewsList]);
	} else {
		providerCounts.exa = 0;
	}

	void providerCounts;

	let newsAnalysisList: NewsAnalysis[];
	try {
		newsAnalysisList = await newsRuntime.analyzeNews(ticker, rawNewsList);
	} catch {
		newsAnalysisList = _fallbackAnalysisFromProviders(rawNewsList);
	}
	const newsList = rawNewsList.map((news, index) =>
		newsArticleSchema.parse({
			...news,
			...newsAnalysisList[index],
		}),
	);

	return _finalizeNewsFeed(_balanceDomains(newsList));
}

export function getNews(
	ticker: string,
	nDays = 3,
	maxResults = 10,
): Promise<NewsArticle[]> {
	return getNewsAsync(ticker, nDays, maxResults);
}
