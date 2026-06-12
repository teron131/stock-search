/** Optionally analyze fetched articles into structured ticker news signals. */

import type { MemoryCache } from "../../cache.js";
import {
	type NewsAnalysis,
	NewsAnalysisModelSchema,
	NewsAnalysisSchema,
	type NewsArticle,
} from "../../models/schemas.js";
import { NEWS_ANALYSIS_PROMPT } from "../../prompts.js";
import type { NewsTickerIdentity } from "./identity.js";
import { FALLBACK_SUMMARIES, normalizeNewsUrl } from "./selection.js";

const MAX_ANALYSIS_WORKERS = 10;
const MAX_PROVIDER_SUMMARY_CHARS = 1_200;

type ChatOpenAIClient = (input: {
	model: string;
	temperature: number;
	reasoningEffort: "low";
}) => {
	withStructuredOutput(schema: unknown): {
		invoke(input: string): Promise<unknown> | unknown;
	};
};

export type AnalysisDeps = {
	chatOpenAI?: ChatOpenAIClient;
	webloader: (urls: string[]) => Promise<Array<string | null | undefined>>;
};

type ProviderBatchItem = {
	index: number;
	cacheKey: string;
	news: NewsArticle;
};

type ReadableAnalysisItem = ProviderBatchItem & {
	content: string;
};

function formatPrompt(
	template: string,
	values: Record<string, string>,
): string {
	return template.replace(/\{([a-z_]+)\}/gi, (match, key) =>
		Object.hasOwn(values, key) ? values[key] : match,
	);
}

function splitCachedAnalysis(
	newsList: NewsArticle[],
	analysisCache: MemoryCache<NewsAnalysis>,
): {
	results: NewsAnalysis[];
	uncachedItems: ProviderBatchItem[];
} {
	const failed = NewsAnalysisSchema.parse({
		summary: FALLBACK_SUMMARIES[1],
	});
	const results = newsList.map(() => ({ ...failed }));
	const uncachedItems: ProviderBatchItem[] = [];

	newsList.forEach((news, index) => {
		const cacheKey = normalizeNewsUrl(news.url);
		const cached = analysisCache.get(cacheKey);
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

function normalizeAnalysisText(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function trimAnalysisText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars).trimEnd()}...`;
}

function providerSummaryContent(news: NewsArticle): string | null {
	const summary = normalizeAnalysisText(news.summary ?? "");
	if (
		!summary ||
		FALLBACK_SUMMARIES.some((prefix) => summary.startsWith(prefix))
	) {
		return null;
	}
	return trimAnalysisText(summary, MAX_PROVIDER_SUMMARY_CHARS);
}

async function buildAnalysisBatch(
	tickerIdentity: NewsTickerIdentity,
	uncachedItems: ProviderBatchItem[],
	deps: AnalysisDeps,
): Promise<{
	readableItems: ReadableAnalysisItem[];
	prompts: string[];
}> {
	const webContentByIndex = new Map<number, string>();
	if (uncachedItems.length > 0) {
		const contentList = await deps.webloader(
			uncachedItems.map((item) => item.news.url),
		);
		uncachedItems.forEach((item, index) => {
			const content = contentList[index];
			if (typeof content === "string" && content.trim()) {
				webContentByIndex.set(item.index, normalizeAnalysisText(content));
			}
		});
	}

	const readableItems = uncachedItems
		.map((item) => ({
			...item,
			content:
				webContentByIndex.get(item.index) ?? providerSummaryContent(item.news),
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

function mergeAnalysisResults(
	results: NewsAnalysis[],
	readableItems: ReadableAnalysisItem[],
	responses: NewsAnalysis[],
	analysisCache: MemoryCache<NewsAnalysis>,
): NewsAnalysis[] {
	readableItems.forEach((item, index) => {
		const analysis = responses[index];
		results[item.index] = analysis;
		if (
			!FALLBACK_SUMMARIES.some((prefix) => analysis.summary.startsWith(prefix))
		) {
			analysisCache.set(item.cacheKey, analysis);
		}
	});
	return results;
}

export function fallbackAnalysisFromProviders(
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

function fillUncachedAnalysisFromProviders(
	results: NewsAnalysis[],
	uncachedItems: ProviderBatchItem[],
): NewsAnalysis[] {
	const fallbacks = fallbackAnalysisFromProviders(
		uncachedItems.map((item) => item.news),
	);
	uncachedItems.forEach((item, index) => {
		results[item.index] = fallbacks[index];
	});
	return results;
}

export async function analyzeNews({
	tickerIdentity,
	newsList,
	deps,
	analysisCache,
	qualityModel,
	fastModel,
}: {
	tickerIdentity: NewsTickerIdentity;
	newsList: NewsArticle[];
	deps: AnalysisDeps;
	analysisCache: MemoryCache<NewsAnalysis>;
	qualityModel?: string;
	fastModel?: string;
}): Promise<NewsAnalysis[]> {
	const { results, uncachedItems } = splitCachedAnalysis(
		newsList,
		analysisCache,
	);
	if (uncachedItems.length === 0) {
		return results;
	}

	const modelName = qualityModel || fastModel;
	if (!deps.chatOpenAI || !modelName) {
		return fillUncachedAnalysisFromProviders(results, uncachedItems);
	}

	const model = deps
		.chatOpenAI({
			model: modelName,
			temperature: 0,
			reasoningEffort: "low",
		})
		.withStructuredOutput(NewsAnalysisModelSchema);
	const { readableItems, prompts } = await buildAnalysisBatch(
		tickerIdentity,
		uncachedItems,
		deps,
	);
	if (readableItems.length === 0) {
		return fillUncachedAnalysisFromProviders(results, uncachedItems);
	}

	const responses = await invokeStructuredBatch(model, prompts, (value) =>
		NewsAnalysisSchema.parse(value),
	);
	return mergeAnalysisResults(results, readableItems, responses, analysisCache);
}
