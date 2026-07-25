/** Fetches Exa news search results and normalizes them into NewsArticle rows.
Playground: https://dashboard.exa.ai/playground/search
Documentation: https://docs.exa.ai/reference/search
- $5 per 1000 results when max results is up to 25
- Other LLM analysis costs apply, so disabled here
*/

import { type NewsArticle, NewsArticleSchema } from "../../models/schemas.js";
import {
  DAY_IN_MS,
  daysAgo,
  fetchJson,
  formatDate,
  normalizeDomain,
  parseDateString,
  readJsonResponse,
} from "./shared.js";

const EXA_PROVIDER_MAX_RESULTS = 25;

export async function getNewsExaAsync({
  query,
  nDays = 3,
  maxResults = EXA_PROVIDER_MAX_RESULTS,
  client,
}: {
  query: string;
  nDays?: number;
  maxResults?: number;
  client?: {
    post: (input: {
      url: string;
      json: Record<string, unknown>;
      headers: Record<string, string>;
    }) => Promise<{
      json(): Promise<unknown> | unknown;
      ok?: boolean;
      raise_for_status?: () => void;
    }>;
  };
}): Promise<NewsArticle[]> {
  const boundedMaxResults = Math.min(maxResults, EXA_PROVIDER_MAX_RESULTS);
  const payloadBody = {
    query,
    category: "news",
    numResults: boundedMaxResults,
    startPublishedDate: new Date(Date.now() - nDays * DAY_IN_MS).toISOString(),
    endPublishedDate: new Date().toISOString(),
    type: "auto",
    userLocation: "US",
  };
  const headers = {
    Authorization: `Bearer ${process.env.EXA_API_KEY ?? ""}`,
    "Content-Type": "application/json",
  };
  const payload = client
    ? await readJsonResponse<{
        results?: Array<Record<string, unknown>>;
      } | null>(
        await client.post({
          url: "https://api.exa.ai/search",
          json: payloadBody,
          headers,
        }),
      )
    : await fetchJson<{ results?: Array<Record<string, unknown>> }>("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          authorization: headers.Authorization,
          "content-type": headers["Content-Type"],
        },
        body: JSON.stringify(payloadBody),
      });
  const fetchedAt = new Date().toISOString();
  return (payload?.results ?? [])
    .filter((row) => typeof row?.url === "string")
    .map((row) => {
      const publishedAt = parseDateString(String(row.publishedDate ?? ""));
      const rawUrl = String(row.url);
      return NewsArticleSchema.parse({
        url: rawUrl,
        title: String(row.title ?? rawUrl),
        date: formatDate(publishedAt),
        days_ago: daysAgo(publishedAt),
        summary: "[FAILED TO FETCH]",
        relevancy: "low",
        category: "other",
        sentiment: "neutral",
        metadata: {
          provider: "exa",
          source_domain: normalizeDomain(rawUrl),
          published_at: publishedAt?.toISOString() ?? null,
          fetched_at: fetchedAt,
        },
      });
    });
}
