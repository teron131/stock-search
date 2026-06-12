/** Select ranked, retained, displayable feed items from raw news candidates. */

import type { NewsArticle } from "../../models/schemas.js";
import { DAY_IN_MS, parseDateString } from "../providers/shared.js";

export const FALLBACK_SUMMARIES = ["[TRUNCATED]", "[FAILED TO FETCH]"] as const;

const DEFAULT_NEWS_DAYS = 3;
const MAX_NON_ASCII_LATIN_RATIO = 0.1;
const MIN_NON_ASCII_LATIN_LETTERS = 5;
const RELEVANCY_ORDER: Record<NewsArticle["relevancy"], number> = {
	high: 0,
	medium: 1,
	low: 2,
};

type NewsTickerIdentity = {
	ticker: string;
	searchTerms: string[];
};

export function normalizeNewsUrl(rawUrl: string): string {
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
		return new URL(normalizeNewsUrl(rawUrl)).hostname.replace(/^www\./, "");
	} catch {
		return rawUrl;
	}
}

export function dedupeNews(items: NewsArticle[]): NewsArticle[] {
	const seenUrls = new Set<string>();
	const seenTitles = new Set<string>();
	const dedupedItems: NewsArticle[] = [];
	for (const item of items) {
		const urlKey = item.url ? normalizeNewsUrl(item.url) : "";
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

export function rankNewsCandidates(
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

function normalizeNewsMetadata(
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

function parseRetentionDatetime(value: string | null | undefined): Date | null {
	return parseDateString(value ?? undefined);
}

export function isNewsItemWithinRetention(
	news: NewsArticle,
	{
		now = new Date(),
		retentionDays = DEFAULT_NEWS_DAYS,
	}: { now?: Date; retentionDays?: number } = {},
): boolean {
	const metadata = normalizeNewsMetadata(news.metadata);
	const boundedRetentionDays = Number.isFinite(retentionDays)
		? Math.max(0, retentionDays)
		: DEFAULT_NEWS_DAYS;
	const maxAgeMs = boundedRetentionDays * DAY_IN_MS;

	const fetchedAt = parseRetentionDatetime(metadata.fetched_at);
	if (fetchedAt && now.getTime() - fetchedAt.getTime() > maxAgeMs) {
		return false;
	}

	if (typeof news.days_ago === "number") {
		return news.days_ago <= boundedRetentionDays;
	}

	const publishedAt = parseRetentionDatetime(metadata.published_at);
	if (publishedAt) {
		return now.getTime() - publishedAt.getTime() <= maxAgeMs;
	}

	const publishedDate = parseRetentionDatetime(news.date);
	if (publishedDate) {
		return now.getTime() - publishedDate.getTime() <= maxAgeMs;
	}

	return fetchedAt !== null;
}

export function isEnglishNewsItem(news: NewsArticle): boolean {
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

export function balanceDomains(items: NewsArticle[]): NewsArticle[] {
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

export function finalizeNewsFeed(
	newsList: NewsArticle[],
	{ retentionDays = DEFAULT_NEWS_DAYS }: { retentionDays?: number } = {},
): NewsArticle[] {
	const filteredNewsList = newsList.filter(
		(news) =>
			!FALLBACK_SUMMARIES.some((prefix) => news.summary.startsWith(prefix)) &&
			news.relevancy !== "low" &&
			isEnglishNewsItem(news) &&
			isNewsItemWithinRetention(news, { retentionDays }),
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
