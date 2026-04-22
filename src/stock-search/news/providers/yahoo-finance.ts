/** yfinance
Documentation: https://ranaroussi.github.io/yfinance/reference/api/yfinance.Search.html
- Free
*/

import {
	daysAgo,
	fetchJson,
	formatDate,
	NEWS_PROVIDER_MAX_RESULTS,
	normalizeDomain,
	parseDate,
} from "./shared.js";
import { newsArticleSchema, type NewsArticle } from "../../models/schemas.js";

const YFINANCE_PROVIDER_MAX_RESULTS = 25;
export const YFINANCE_MAX_RESULTS = NEWS_PROVIDER_MAX_RESULTS;

export async function getNewsYahooFinance({
	ticker,
	maxResults = YFINANCE_MAX_RESULTS,
}: {
	ticker: string;
	maxResults?: number;
}): Promise<NewsArticle[]> {
	const boundedMaxResults = Math.min(
		maxResults,
		YFINANCE_MAX_RESULTS,
		YFINANCE_PROVIDER_MAX_RESULTS,
	);
	const url = new URL("https://query1.finance.yahoo.com/v1/finance/search");
	url.searchParams.set("q", ticker);
	url.searchParams.set("quotesCount", "0");
	url.searchParams.set("newsCount", String(boundedMaxResults));
	url.searchParams.set("enableFuzzyQuery", "false");
	url.searchParams.set("enableNavLinks", "false");
	url.searchParams.set("enableResearchReports", "false");
	url.searchParams.set("enableCulturalAssets", "false");

	const payload = await fetchJson<{ news?: Array<Record<string, unknown>> }>(
		url.toString(),
	);
	if (!payload?.news?.length) {
		return [];
	}

	const fetchedAt = new Date().toISOString();
	return payload.news.map((row) => {
		const publishedAt = parseDate(row.providerPublishTime);
		const rawUrl = String(row.link ?? "");
		return newsArticleSchema.parse({
			url: rawUrl,
			title: String(row.title ?? rawUrl),
			date: formatDate(publishedAt),
			days_ago: daysAgo(publishedAt),
			summary: String(row.description ?? "[FAILED TO FETCH]"),
			metadata: {
				provider: "yfinance",
				source_domain: normalizeDomain(rawUrl),
				published_at: publishedAt?.toISOString() ?? null,
				fetched_at: fetchedAt,
			},
		});
	});
}
