/** Massive
Documentation: https://massive.com/docs/rest/stocks/news
- Free
- 5 API Calls / Minute
- Max 1000 results per query
*/

import {
	daysAgo,
	fetchJson,
	formatDate,
	normalizeDomain,
	parseDate,
	readJsonResponse,
	DAY_IN_MS,
} from "./shared.js";
import { newsArticleSchema, type NewsArticle } from "../../models/schemas.js";

const SENTIMENT_MAP: Record<string, NewsArticle["sentiment"]> = {
	positive: "bullish",
	neutral: "neutral",
	negative: "bearish",
};

export const MASSIVE_MAX_RESULTS = 1000;

export async function getNewsMassiveAsync({
	ticker,
	nDays = 3,
	maxResults = 25,
	client,
}: {
	ticker: string;
	nDays?: number;
	maxResults?: number;
	client?: {
		get: (input: {
			url: string;
			params: Record<string, string>;
		}) => Promise<{ json(): Promise<unknown> | unknown; raise_for_status?: () => void }>;
	};
}): Promise<NewsArticle[]> {
	const boundedMaxResults = Math.min(maxResults, MASSIVE_MAX_RESULTS);
	const params = {
		apiKey: process.env.MASSIVE_API_KEY ?? "",
		ticker,
		"published_utc.gte": new Date(Date.now() - nDays * DAY_IN_MS).toISOString(),
		order: "desc",
		limit: String(boundedMaxResults),
		sort: "published_utc",
	};
	const url = "https://api.massive.com/v2/reference/news";
	const payload = client
		? await readJsonResponse<{ results?: Array<Record<string, unknown>> } | null>(
				await client.get({ url, params }),
			)
		: await fetchJson<{ results?: Array<Record<string, unknown>> }>(
				`${url}?${new URLSearchParams(params).toString()}`,
			);

	const fetchedAt = new Date().toISOString();
	return (payload?.results ?? []).map((row) => {
		const publishedAt = parseDate(row.published_utc);
		const insights = Array.isArray(row.insights) ? row.insights : [{}];
		const sentiment =
			SENTIMENT_MAP[String((insights[0] as Record<string, unknown>).sentiment ?? "")] ??
			"neutral";
		const rawUrl = String(row.article_url ?? "");
		return newsArticleSchema.parse({
			url: rawUrl,
			title: String(row.title ?? rawUrl),
			date: formatDate(publishedAt),
			days_ago: daysAgo(publishedAt),
			summary: String(row.description ?? "[FAILED TO FETCH]"),
			sentiment,
			metadata: {
				provider: "massive",
				source_domain: normalizeDomain(rawUrl),
				published_at: publishedAt?.toISOString() ?? null,
				fetched_at: fetchedAt,
			},
		});
	});
}
