/** Fetch raw news articles from enabled providers with rate limits. */

import type { NewsArticle } from "../../models/schemas.js";

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

export function hasEnvValue(value: string | undefined): boolean {
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

export function createHttpClient(): HttpClient {
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

export async function fetchProviderBatch(
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
