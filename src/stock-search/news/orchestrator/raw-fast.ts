/** Build the fast, non-LLM ticker news feed from ranked provider articles. */

import { type NewsArticle, NewsArticleSchema } from "../../models/schemas.js";
import {
	balanceDomains,
	FALLBACK_SUMMARIES,
	isEnglishNewsItem,
	isNewsItemWithinRetention,
} from "./router.js";

const MAX_RAW_FAST_NEWS_SUMMARY_CHARS = 700;
const MAX_RAW_FAST_NEWS_CONTENT_CHARS = 1_200;

export type RawFastNewsDeps = {
	webloader: (urls: string[]) => Promise<Array<string | null | undefined>>;
};

function normalizeNewsText(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function trimNewsText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars).trimEnd()}...`;
}

function providerSummaryForRawFastNews(news: NewsArticle): string {
	const summary = normalizeNewsText(news.summary ?? "");
	if (!summary) {
		return "";
	}
	for (const prefix of FALLBACK_SUMMARIES) {
		if (summary === prefix) {
			return "";
		}
		if (summary.startsWith(`${prefix} `)) {
			return trimNewsText(
				summary.slice(prefix.length).trim(),
				MAX_RAW_FAST_NEWS_SUMMARY_CHARS,
			);
		}
	}
	return trimNewsText(summary, MAX_RAW_FAST_NEWS_SUMMARY_CHARS);
}

function isRawFastNewsUrl(url: string): boolean {
	return !/consent|privacy|cookie/i.test(url);
}

async function attachRawFastContentExcerpts(
	newsList: NewsArticle[],
	deps: RawFastNewsDeps,
): Promise<NewsArticle[]> {
	let contentList: Array<string | null | undefined>;
	try {
		contentList = await deps.webloader(newsList.map((news) => news.url));
	} catch {
		contentList = newsList.map(() => null);
	}
	return newsList.map((news, index) => {
		const content = contentList[index];
		const contentExcerpt =
			typeof content === "string" && content.trim()
				? trimNewsText(
						normalizeNewsText(content),
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

export async function buildRawFastNews({
	newsList,
	nDays,
	maxResults,
	deps,
}: {
	newsList: NewsArticle[];
	nDays: number;
	maxResults: number;
	deps: RawFastNewsDeps;
}): Promise<NewsArticle[]> {
	const candidates = balanceDomains(
		newsList.filter(
			(news) =>
				isRawFastNewsUrl(news.url) &&
				isEnglishNewsItem(news) &&
				isNewsItemWithinRetention(news, { retentionDays: nDays }),
		),
	).slice(0, maxResults);
	return attachRawFastContentExcerpts(candidates, deps);
}
