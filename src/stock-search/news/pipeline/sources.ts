/** Fetch and dedupe raw ticker news from configured provider sources. */

import type { NewsArticle } from "../../models/schemas.js";
import * as newsProviders from "../providers/index.js";
import type { NewsTickerIdentity } from "./identity.js";
import { dedupeNews } from "./selection.js";

const NEWS_PROVIDER_TIMEOUT_MS = 8_000;

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

export type ProviderSpec = readonly [string, () => Promise<NewsArticle[]>];

export type HttpResponse = {
	ok?: boolean;
	status?: number;
	json(): Promise<unknown>;
	raise_for_status?: () => void;
};

export type HttpClient = {
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

export type NewsSourceFetchContext = {
	ticker: string;
	nDays: number;
	maxResults: number;
	tickerIdentity: NewsTickerIdentity;
};

function hasEnvValue(value: string | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
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

async function fetchProviderBatch(
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

function providerQueryForTickerIdentity(
	tickerIdentity: NewsTickerIdentity,
): string {
	return tickerIdentity.companyName
		? tickerIdentity.label
		: tickerIdentity.ticker;
}

function buildPrimaryProviderSpecs(
	context: NewsSourceFetchContext,
	client: ReturnType<typeof createHttpClient>,
): ProviderSpec[] {
	const { ticker, nDays, tickerIdentity } = context;
	const providerQuery = providerQueryForTickerIdentity(tickerIdentity);
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

	return primaryProviderSpecs;
}

export async function fetchRawNewsFromSources(
	context: NewsSourceFetchContext,
): Promise<NewsArticle[]> {
	const client = createHttpClient();
	const providerQuery = providerQueryForTickerIdentity(context.tickerIdentity);
	const primaryProviderSpecs = buildPrimaryProviderSpecs(context, client);
	let rawNewsList = dedupeNews(await fetchProviderBatch(primaryProviderSpecs));

	if (
		rawNewsList.length < context.maxResults &&
		hasEnvValue(process.env.EXA_API_KEY)
	) {
		const exaNewsList = await fetchProviderBatch([
			[
				"exa",
				() =>
					newsProviders.getNewsExaAsync({
						query: providerQuery,
						nDays: context.nDays,
						client,
					}),
			],
		]);
		rawNewsList = dedupeNews([...rawNewsList, ...exaNewsList]);
	}

	return rawNewsList;
}
