/** NewsData
Playground: https://newsdata.io/search-dashboard
Documentation: https://newsdata.io/documentation#latest-news
- Free
- 200 credits per day
- 10 articles per credit
- Last 48 hours news
*/

import {
	daysAgo,
	fetchJson,
	formatDate,
	normalizeDomain,
	parseDateString,
	readJsonResponse,
} from "./shared.js";
import { newsArticleSchema, type NewsArticle } from "../../models/schemas.js";

export async function getNewsNewsDataAsync({
	query,
	client,
}: {
	query: string;
	client?: {
		get: (input: {
			url: string;
			params: Record<string, string>;
		}) => Promise<{ json(): Promise<unknown> | unknown; raise_for_status?: () => void }>;
	};
}): Promise<NewsArticle[]> {
	const url = new URL("https://newsdata.io/api/1/latest");
	const params = {
		apikey: process.env.NEWSDATA_API_KEY ?? "",
		q: query,
		country: "us",
		language: "en",
		category: "business,breaking,politics,technology,top",
		prioritydomain: "top",
		video: "0",
		removeduplicate: "1",
		sort: "relevancy",
	};

	const payload = client
		? await readJsonResponse<{ results?: Array<Record<string, unknown>> } | null>(
				await client.get({
					url: url.toString(),
					params,
				}),
			)
		: await fetchJson<{ results?: Array<Record<string, unknown>> }>(
				`${url.toString()}?${new URLSearchParams(params).toString()}`,
			);
	const fetchedAt = new Date().toISOString();
	return (payload?.results ?? [])
		.filter((row) => typeof row?.link === "string")
		.map((row) => {
			const publishedAt = parseDateString(String(row.pubDate ?? ""));
			const rawUrl = String(row.link);
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
					provider: "newsdata",
					source_domain: normalizeDomain(rawUrl),
					published_at: publishedAt?.toISOString() ?? null,
					fetched_at: fetchedAt,
				},
			});
		});
}
