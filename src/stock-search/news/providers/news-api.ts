/** NewsAPI
Documentation: https://newsapi.org/docs/endpoints/everything
- Free
- 24 hours delay
- 100 requests per day
- Max 100 results per query
*/

import {
	daysAgo,
	fetchJson,
	formatDate,
	normalizeDomain,
	parseDateString,
	readJsonResponse,
	DAY_IN_MS,
} from "./shared.js";
import { newsArticleSchema, type NewsArticle } from "../../models/schemas.js";

export const NEWSAPI_MAX_RESULTS = 100;

export async function getNewsNewsApiAsync({
	query,
	nDays = 3,
	maxResults = 25,
	client,
}: {
	query: string;
	nDays?: number;
	maxResults?: number;
	client?: {
		get: (input: {
			url: string;
			params: Record<string, string>;
		}) => Promise<{ json(): Promise<unknown> | unknown; raise_for_status?: () => void }>;
	};
}): Promise<NewsArticle[]> {
	const now = new Date();
	const boundedMaxResults = Math.min(maxResults, NEWSAPI_MAX_RESULTS);
	const fromDate = new Date(now.getTime() - nDays * DAY_IN_MS)
		.toISOString()
		.slice(0, 10);
	const toDate = new Date(now.getTime() - DAY_IN_MS).toISOString().slice(0, 10);
	const url = new URL("https://newsapi.org/v2/everything");
	const params = {
		apiKey: process.env.NEWS_API_KEY ?? "",
		q: query,
		from: fromDate,
		to: toDate,
		language: "en",
		sortBy: "popularity",
		pageSize: String(boundedMaxResults),
	};
	const payload = client
		? await readJsonResponse<{ articles?: Array<Record<string, unknown>> } | null>(
				await client.get({
					url: url.toString(),
					params,
				}),
			)
		: await fetchJson<{ articles?: Array<Record<string, unknown>> }>(
				`${url.toString()}?${new URLSearchParams(params).toString()}`,
			);
	const fetchedAt = new Date().toISOString();
	return (payload?.articles ?? [])
		.filter((row) => typeof row?.url === "string")
		.map((row) => {
			const publishedAt = parseDateString(String(row.publishedAt ?? ""));
			const rawUrl = String(row.url);
			return newsArticleSchema.parse({
				url: rawUrl,
				title: String(row.title ?? rawUrl),
				date: formatDate(publishedAt),
				days_ago: daysAgo(publishedAt),
				summary: `[TRUNCATED] ${String(row.description ?? "")}`.trim(),
				relevancy: "low",
				category: "other",
				sentiment: "neutral",
				metadata: {
					provider: "newsapi",
					source_domain: normalizeDomain(rawUrl),
					published_at: publishedAt?.toISOString() ?? null,
					fetched_at: fetchedAt,
				},
			});
		});
}
