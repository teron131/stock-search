import { ChatOpenAI } from "llm-harness-js/clients";

import { TieredCache } from "../cache.js";
import { YahooFinanceSource } from "../data-sources/yahoo-finance.js";
import {
	type NewsAnalysis,
	NewsAnalysisModelSchema,
	NewsAnalysisSchema,
	type NewsArticle,
	NewsArticleSchema,
	type PortfolioNewsChapter,
	PortfolioNewsChapterSchema,
	PortfolioNewsSummaryModelSchema,
	type PortfolioNewsSummaryRequestArticle,
	PortfolioNewsSummaryRequestArticleSchema,
	type PortfolioNewsSummaryRequestRow,
	PortfolioNewsSummaryRequestRowSchema,
	type PortfolioNewsSummaryResponse,
	PortfolioNewsSummaryResponseSchema,
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
const QUALITY_LLM = process.env.QUALITY_LLM;
const MAX_ANALYSIS_WORKERS = 10;
const MAX_NEWS_ANALYSIS_CANDIDATES = 25;
const MAX_PORTFOLIO_SUMMARY_TICKERS = 5;
const MAX_PORTFOLIO_SUMMARY_ITEMS = 3;
const MAX_PORTFOLIO_SUMMARY_ARTICLES = 18;
const MAX_PORTFOLIO_SUMMARY_MACRO_ITEMS = 2;
const MAX_PROVIDER_SUMMARY_CHARS = 1_200;
const DEFAULT_NEWS_DAYS = 3;
const NEWS_PROVIDER_TIMEOUT_MS = 8_000;
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
const COMPANY_NAME_STOP_WORDS = new Set([
	"ads",
	"adr",
	"class",
	"common",
	"corp",
	"corporation",
	"depositary",
	"inc",
	"incorporated",
	"limited",
	"ltd",
	"ordinary",
	"plc",
	"shares",
	"stock",
]);

export const ANALYSIS_CACHE = new TieredCache<NewsAnalysis>({
	ttlSeconds: 7 * 24 * 60 * 60,
	staleSeconds: 30 * 24 * 60 * 60,
	failureCooldownSeconds: 10 * 60,
});

export type NewsTickerIdentity = {
	ticker: string;
	companyName: string | null;
	label: string;
	searchTerms: string[];
};

export type NewsFetchOptions = {
	nDays?: number;
	maxResults?: number;
	tickerIdentity?: NewsTickerIdentity;
	resolveIdentity?: boolean;
};

export const newsPipelineDeps = {
	chatOpenAI: ChatOpenAI,
	webloader: webloaderModule.webloader,
	resolveTickerIdentity: resolveTickerIdentityFromYahoo,
};

export const newsRuntime = {
	analyzeNews: (
		ticker: string,
		newsList: NewsArticle[],
		tickerIdentity?: NewsTickerIdentity,
	) => _analyzeNews(ticker, newsList, tickerIdentity),
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
	status?: number;
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
		status: response.status,
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

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs = NEWS_PROVIDER_TIMEOUT_MS,
): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeoutId);
	}
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
				await fetchWithTimeout(targetUrl, {
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
				await fetchWithTimeout(url, {
					method: "POST",
					headers,
					body: JSON.stringify(json),
				}),
			);
		},
	};
}

function hasEnvValue(value: string | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function cleanCompanyName(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const name = value.trim().replace(/\s+/g, " ");
	return name && !/^[A-Z0-9.\-]+$/.test(name) ? name : null;
}

function addSearchTerm(terms: string[], seen: Set<string>, term: string): void {
	const normalizedTerm = term.trim().replace(/\s+/g, " ");
	const key = normalizedTerm.toLowerCase();
	if (!normalizedTerm || seen.has(key)) {
		return;
	}
	seen.add(key);
	terms.push(normalizedTerm);
}

function companyNameSearchTerms(companyName: string | null): string[] {
	if (!companyName) {
		return [];
	}

	const terms: string[] = [];
	const seen = new Set<string>();
	addSearchTerm(terms, seen, companyName.replace(/\./g, ""));

	const words = companyName
		.replace(/[^\p{L}\p{N}&]+/gu, " ")
		.split(/\s+/)
		.map((word) => word.trim())
		.filter((word) => {
			const key = word.toLowerCase();
			return (
				word.length >= 3 &&
				!/^\d+$/.test(word) &&
				!COMPANY_NAME_STOP_WORDS.has(key)
			);
		});
	if (words.length > 0) {
		addSearchTerm(terms, seen, words.join(" "));
	}
	for (const word of words.slice(0, 4)) {
		addSearchTerm(terms, seen, word);
	}
	return terms;
}

export function buildNewsTickerIdentity(
	tickerInput: string,
	companyNameInput: unknown = null,
): NewsTickerIdentity {
	const ticker = normalizeTicker(tickerInput);
	const companyName = cleanCompanyName(companyNameInput);
	const label = companyName ? `${ticker} (${companyName})` : ticker;
	const terms: string[] = [];
	const seen = new Set<string>();
	for (const term of companyNameSearchTerms(companyName)) {
		addSearchTerm(terms, seen, term);
	}
	addSearchTerm(terms, seen, ticker);
	return {
		ticker,
		companyName,
		label,
		searchTerms: terms,
	};
}

async function resolveTickerIdentityFromYahoo(
	ticker: string,
): Promise<NewsTickerIdentity> {
	const metadata = await new YahooFinanceSource(ticker).getSymbolMetadataSnapshot();
	return buildNewsTickerIdentity(ticker, metadata.name);
}

export function _dedupeNews(items: NewsArticle[]): NewsArticle[] {
	const seenUrls = new Set<string>();
	const seenTitles = new Set<string>();
	const dedupedItems: NewsArticle[] = [];
	for (const item of items) {
		const urlKey = item.url ? normalizeUrl(item.url) : "";
		const titleKey = (item.title ?? "").trim().toLowerCase();
		if (
			(urlKey && seenUrls.has(urlKey)) ||
			(titleKey && seenTitles.has(titleKey))
		) {
			continue;
		}
		if (urlKey) {
			seenUrls.add(urlKey);
		}
		if (titleKey) {
			seenTitles.add(titleKey);
		}
		dedupedItems.push(item);
	}
	return dedupedItems;
}

function wordIncludes(text: string, term: string): boolean {
	const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^a-z0-9])${escapedTerm}([^a-z0-9]|$)`, "i").test(text);
}

function entityMatchScore(text: string, terms: string[]): number {
	for (const [index, term] of terms.entries()) {
		if (wordIncludes(text, term)) {
			return terms.length - index;
		}
	}
	return 0;
}

function newsCandidateSignals(
	tickerIdentity: NewsTickerIdentity,
	news: NewsArticle,
): {
	titleMatchScore: number;
	summaryMatchScore: number;
	urlMatchScore: number;
	hasUsableSummary: boolean;
	isConsentUrl: boolean;
	daysAgo: number;
} {
	const terms =
		tickerIdentity.searchTerms.length > 0
			? tickerIdentity.searchTerms
			: [tickerIdentity.ticker];
	const title = news.title ?? "";
	const summary = news.summary ?? "";
	const url = news.url ?? "";
	const isFallback = FALLBACK_SUMMARIES.some((prefix) =>
		summary.startsWith(prefix),
	);
	return {
		titleMatchScore: entityMatchScore(title, terms),
		summaryMatchScore: entityMatchScore(summary, terms),
		urlMatchScore: entityMatchScore(url, terms),
		hasUsableSummary: Boolean(summary.trim()) && !isFallback,
		isConsentUrl: /consent|privacy|cookie/i.test(url),
		daysAgo: news.days_ago ?? Number.POSITIVE_INFINITY,
	};
}

function _rankNewsCandidates(
	tickerIdentity: NewsTickerIdentity,
	newsList: NewsArticle[],
): NewsArticle[] {
	return newsList
		.map((news, index) => ({
			index,
			news,
			signals: newsCandidateSignals(tickerIdentity, news),
		}))
		.sort((left, right) => {
			const signalOrder = [
				"titleMatchScore",
				"summaryMatchScore",
				"urlMatchScore",
				"hasUsableSummary",
			] as const;
			for (const signal of signalOrder) {
				if (left.signals[signal] !== right.signals[signal]) {
					return Number(right.signals[signal]) - Number(left.signals[signal]);
				}
			}
			if (left.signals.isConsentUrl !== right.signals.isConsentUrl) {
				return (
					Number(left.signals.isConsentUrl) - Number(right.signals.isConsentUrl)
				);
			}
			if (left.signals.daysAgo !== right.signals.daysAgo) {
				return left.signals.daysAgo - right.signals.daysAgo;
			}
			return left.index - right.index;
		})
		.map((item) => item.news);
}

function _normalizeNewsMetadata(
	metadata:
		| NewsArticle["metadata"]
		| Record<string, unknown>
		| null
		| undefined,
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

function _parseRetentionDatetime(
	value: string | null | undefined,
): Date | null {
	return parseDateString(value ?? undefined);
}

export function _isNewsItemWithinRetention(
	news: NewsArticle,
	{
		now = new Date(),
		retentionDays = DEFAULT_NEWS_DAYS,
	}: { now?: Date; retentionDays?: number } = {},
): boolean {
	const metadata = _normalizeNewsMetadata(news.metadata);
	const boundedRetentionDays = Number.isFinite(retentionDays)
		? Math.max(0, retentionDays)
		: DEFAULT_NEWS_DAYS;
	const maxAgeMs = boundedRetentionDays * DAY_IN_MS;

	const fetchedAt = _parseRetentionDatetime(metadata.fetched_at);
	if (fetchedAt && now.getTime() - fetchedAt.getTime() > maxAgeMs) {
		return false;
	}

	if (typeof news.days_ago === "number") {
		return news.days_ago <= boundedRetentionDays;
	}

	const publishedAt = _parseRetentionDatetime(metadata.published_at);
	if (publishedAt) {
		return now.getTime() - publishedAt.getTime() <= maxAgeMs;
	}

	const publishedDate = _parseRetentionDatetime(news.date);
	if (publishedDate) {
		return now.getTime() - publishedDate.getTime() <= maxAgeMs;
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
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined || codePoint <= 127) {
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

function _splitCachedAnalysis(newsList: NewsArticle[]): {
	results: NewsAnalysis[];
	uncachedItems: ProviderBatchItem[];
} {
	const failed = NewsAnalysisSchema.parse({
		summary: FALLBACK_SUMMARIES[1],
	});
	const results = newsList.map(() => ({ ...failed }));
	const uncachedItems: ProviderBatchItem[] = [];

	newsList.forEach((news, index) => {
		const cacheKey = normalizeUrl(news.url);
		const cached = ANALYSIS_CACHE.getStale(cacheKey);
		if (cached) {
			results[index] = cached;
			return;
		}
		uncachedItems.push({ index, cacheKey, news });
	});

	return {
		results,
		uncachedItems,
	};
}

function _normalizeAnalysisText(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function _trimAnalysisText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars).trimEnd()}...`;
}

function _providerSummaryContent(news: NewsArticle): string | null {
	const summary = _normalizeAnalysisText(news.summary ?? "");
	if (
		!summary ||
		FALLBACK_SUMMARIES.some((prefix) => summary.startsWith(prefix))
	) {
		return null;
	}
	return _trimAnalysisText(summary, MAX_PROVIDER_SUMMARY_CHARS);
}

async function _buildAnalysisBatch(
	tickerIdentity: NewsTickerIdentity,
	uncachedItems: ProviderBatchItem[],
): Promise<{
	readableItems: ReadableAnalysisItem[];
	prompts: string[];
}> {
	const webContentByIndex = new Map<number, string>();
	if (uncachedItems.length > 0) {
		const contentList = await newsPipelineDeps.webloader(
			uncachedItems.map((item) => item.news.url),
		);
		uncachedItems.forEach((item, index) => {
			const content = contentList[index];
			if (typeof content === "string" && content.trim()) {
				webContentByIndex.set(item.index, _normalizeAnalysisText(content));
			}
		});
	}

	const readableItems = uncachedItems
		.map((item) => ({
			...item,
			content:
				webContentByIndex.get(item.index) ?? _providerSummaryContent(item.news),
		}))
		.filter(
			(item): item is ReadableAnalysisItem =>
				typeof item.content === "string" && item.content.trim().length > 0,
		);

	return {
		readableItems,
		prompts: readableItems.map(({ news, content }) =>
			formatPrompt(NEWS_ANALYSIS_PROMPT, {
				ticker_label: tickerIdentity.label,
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
		if (
			!FALLBACK_SUMMARIES.some((prefix) => analysis.summary.startsWith(prefix))
		) {
			ANALYSIS_CACHE.set(item.cacheKey, analysis);
		}
	});
	return results;
}

async function _fetchProviderBatch(
	providerSpecs: readonly ProviderSpec[],
): Promise<NewsArticle[]> {
	const allowedSpecs = providerSpecs.filter(([providerName]) => {
		const limiter = PROVIDER_RATE_LIMITERS.get(providerName);
		return !limiter || limiter.acquire();
	});
	if (allowedSpecs.length === 0) {
		return [];
	}

	const providerResults = await Promise.allSettled(
		allowedSpecs.map(([, providerCall]) => providerCall()),
	);
	return providerResults.flatMap((result) =>
		result.status === "fulfilled" ? result.value : [],
	);
}

export function _finalizeNewsFeed(
	newsList: NewsArticle[],
	{ retentionDays = DEFAULT_NEWS_DAYS }: { retentionDays?: number } = {},
): NewsArticle[] {
	const filteredNewsList = newsList.filter(
		(news) =>
			!FALLBACK_SUMMARIES.some((prefix) => news.summary.startsWith(prefix)) &&
			news.relevancy !== "low" &&
			_isEnglishNewsItem(news) &&
			_isNewsItemWithinRetention(news, { retentionDays }),
	);

	return filteredNewsList.sort((left, right) => {
		const leftDaysAgo =
			typeof left.days_ago === "number"
				? left.days_ago
				: Number.POSITIVE_INFINITY;
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

function _fallbackAnalysisFromProviders(
	newsList: NewsArticle[],
): NewsAnalysis[] {
	return newsList.map((news) =>
		NewsAnalysisSchema.parse({
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
	tickerIdentity: NewsTickerIdentity = buildNewsTickerIdentity(ticker),
): Promise<NewsAnalysis[]> {
	const { results, uncachedItems } = _splitCachedAnalysis(newsList);
	if (uncachedItems.length === 0) {
		return results;
	}

	const model = newsPipelineDeps
		.chatOpenAI({
			model: QUALITY_LLM || FAST_LLM || "",
			temperature: 0,
			reasoningEffort: "low",
		})
		.withStructuredOutput(NewsAnalysisModelSchema);
	const { readableItems, prompts } = await _buildAnalysisBatch(
		tickerIdentity,
		uncachedItems,
	);
	if (readableItems.length === 0) {
		return results;
	}

	const responses = await invokeStructuredBatch(model, prompts, (value) =>
		NewsAnalysisSchema.parse(value),
	);
	return _mergeAnalysisResults(results, readableItems, responses);
}

function _normalizePortfolioNewsSummaryRows(
	rows: PortfolioNewsSummaryRequestRow[],
): Array<{ ticker: string; weight_pct: number }> {
	const normalizedRows: Array<{ ticker: string; weight_pct: number }> = [];
	const seenTickers = new Set<string>();

	const totalValue = rows.reduce((sum, row) => {
		const parsedRow = PortfolioNewsSummaryRequestRowSchema.parse(row);
		const quantity = Number(parsedRow.quantity ?? 0);
		const total = Number(parsedRow.total ?? 0);
		if (!parsedRow.ticker || quantity <= 0 || total <= 0) {
			return sum;
		}
		return sum + total;
	}, 0);

	for (const row of rows) {
		const parsedRow = PortfolioNewsSummaryRequestRowSchema.parse(row);
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

	return normalizedRows.sort(
		(left, right) => right.weight_pct - left.weight_pct,
	);
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
		const parsedItem = PortfolioNewsSummaryRequestArticleSchema.parse(item);
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
		const parsedChapter = PortfolioNewsChapterSchema.parse(chapter);
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
		return PortfolioNewsSummaryResponseSchema.parse({
			has_news: false,
		});
	}

	const topRows = normalizedRows.slice(0, MAX_PORTFOLIO_SUMMARY_TICKERS);
	const heldTickers = new Set(normalizedRows.map((row) => row.ticker));
	const normalizedItems = _normalizePortfolioNewsSummaryItems(
		items,
		heldTickers,
	);
	if (normalizedItems.length === 0) {
		return PortfolioNewsSummaryResponseSchema.parse({
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
		.withStructuredOutput(PortfolioNewsSummaryModelSchema);
	const summary = PortfolioNewsSummaryModelSchema.parse(
		await model.invoke(prompt),
	);

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

	return PortfolioNewsSummaryResponseSchema.parse({
		has_news: true,
		macros,
		top_tickers: topTickers,
	});
}

export const buildPortfolioNewsSummary = summarizePortfolioNewsAsync;

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

	let rawNewsList = _dedupeNews(
		await _fetchProviderBatch(primaryProviderSpecs),
	);
	const primaryAnalysisLimit = Math.max(
		boundedMaxResults,
		Math.min(MAX_NEWS_ANALYSIS_CANDIDATES, rawNewsList.length),
	);

	if (
		rawNewsList.length < primaryAnalysisLimit &&
		hasEnvValue(process.env.EXA_API_KEY)
	) {
		const exaNewsList = await _fetchProviderBatch([
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
		rawNewsList = _dedupeNews([...rawNewsList, ...exaNewsList]);
	}

	const analysisLimit = Math.max(
		boundedMaxResults,
		Math.min(MAX_NEWS_ANALYSIS_CANDIDATES, rawNewsList.length),
	);
	rawNewsList = _rankNewsCandidates(tickerIdentity, rawNewsList).slice(
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
		newsAnalysisList = _fallbackAnalysisFromProviders(rawNewsList);
	}
	const newsList = rawNewsList.map((news, index) =>
		NewsArticleSchema.parse({
			...news,
			...newsAnalysisList[index],
		}),
	);

	return _finalizeNewsFeed(_balanceDomains(newsList), {
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
