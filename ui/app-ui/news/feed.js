/** Load UI news feed data from demo, shared portfolio, cache, and live ticker sources. */

import { CONFIG } from "../config.js";
import {
	normalizeDemoNewsPayload,
	normalizePortfolioNewsPayload,
	normalizeTickerNewsPayload,
} from "../dataContract.js";
import {
	buildCacheSnapshot,
	isCacheFresh,
	writeTickerNewsCache,
} from "./cache.js";
import {
	mapWithConcurrency,
	mergeNewsItems,
	pruneRetainedNewsItems,
} from "./dataModel.js";

/** Fetch JSON with the timeout behavior expected by feed loading. */
async function fetchJsonWithTimeout(url, timeoutMs) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`Request failed: ${response.status}`);
		}
		return await response.json();
	} finally {
		clearTimeout(timeoutId);
	}
}

/** Load demo news for the currently held tickers. */
async function loadDemoNewsFeed(heldTickers) {
	const payload = await fetchJsonWithTimeout(
		CONFIG.demoEndpoints.news,
		CONFIG.requestTimeoutMs.news,
	);
	const normalizedPayload = normalizeDemoNewsPayload(payload);
	if (!normalizedPayload) {
		throw new Error("Invalid demo news payload");
	}

	return {
		items: mergeNewsItems(
			heldTickers.flatMap(
				(ticker) => normalizedPayload.items_by_ticker[ticker] || [],
			),
		),
		generatedAt:
			normalizedPayload.meta.generated_at || new Date().toISOString(),
		failedTickers: [],
	};
}

/** Load a shared portfolio-news snapshot when it covers the current held tickers. */
export async function loadSharedNewsFeed(heldTickers) {
	const payload = await fetchJsonWithTimeout(
		CONFIG.endpoints.portfolioNews,
		CONFIG.requestTimeoutMs.news,
	);
	const normalizedPayload = normalizePortfolioNewsPayload(payload);
	if (!normalizedPayload) {
		return null;
	}

	const snapshotTickers = new Set(normalizedPayload.tickers);
	if (!heldTickers.every((ticker) => snapshotTickers.has(ticker))) {
		return null;
	}

	const heldTickerSet = new Set(heldTickers);
	return {
		...normalizedPayload,
		items: normalizedPayload.items.filter((item) =>
			(item.sourceTickers || []).some((ticker) => heldTickerSet.has(ticker)),
		),
	};
}

/** Load live ticker news while merging successful fetches with existing cache entries. */
async function loadLiveNewsFeed({
	heldTickers,
	force = false,
	staleTickers = [],
}) {
	const cacheSnapshot = buildCacheSnapshot(heldTickers);
	const tickersToFetch = force ? heldTickers : staleTickers;

	if (tickersToFetch.length === 0) {
		return {
			items: cacheSnapshot.items,
			generatedAt: cacheSnapshot.generatedAt,
			failedTickers: [],
			cacheSnapshot,
		};
	}

	const fetchedAt = new Date().toISOString();
	const results = await mapWithConcurrency(
		tickersToFetch,
		CONFIG.newsConcurrency,
		async (ticker) => {
			try {
				const payload = await fetchJsonWithTimeout(
					CONFIG.endpoints.stockNews(ticker),
					CONFIG.requestTimeoutMs.news,
				);
				const items = pruneRetainedNewsItems(
					normalizeTickerNewsPayload(payload, ticker),
				);
				writeTickerNewsCache(ticker, items, fetchedAt);
				return { ticker, ok: true, items, fetchedAt };
			} catch (error) {
				return { ticker, ok: false, error };
			}
		},
	);

	const nextTickerItems = new Map(
		cacheSnapshot.cacheEntries.map((entry) => [entry.ticker, entry.items]),
	);
	results
		.filter((result) => result.ok)
		.forEach((result) => {
			nextTickerItems.set(result.ticker, result.items || []);
		});

	const failedTickers = results
		.filter((result) => !result.ok)
		.map((result) => result.ticker);

	return {
		items: mergeNewsItems(
			Array.from(nextTickerItems.values()).flatMap((items) => items || []),
		),
		generatedAt:
			results.find((result) => result.ok)?.fetchedAt ||
			cacheSnapshot.generatedAt ||
			null,
		failedTickers,
		cacheSnapshot,
	};
}

/** Plan cache hydration and loading mode before any slower feed request runs. */
export function planNewsFeedLoad({
	background = false,
	force = false,
	heldTickers,
	preferDemoData = false,
	visibleItemCount = 0,
}) {
	const cacheSnapshot = preferDemoData ? null : buildCacheSnapshot(heldTickers);
	const hasCachedItems = Boolean(cacheSnapshot?.items.length);
	const staleTickers = preferDemoData
		? []
		: heldTickers.filter((ticker) => {
				const cacheEntry = cacheSnapshot?.cacheEntryMap.get(ticker);
				return !cacheEntry || !isCacheFresh(cacheEntry.fetchedAt);
			});
	const shouldFetchFresh =
		preferDemoData || (!preferDemoData && (force || staleTickers.length > 0));
	const shouldHydrateFromCache =
		hasCachedItems && (!background || visibleItemCount === 0 || Boolean(force));
	const shouldLoadInBackground =
		background || visibleItemCount > 0 || hasCachedItems;

	return {
		cachedResult: shouldHydrateFromCache
			? {
					items: cacheSnapshot.items,
					generatedAt: cacheSnapshot.generatedAt,
					failedTickers: [],
				}
			: null,
		hasCachedItems,
		shouldFetchFresh,
		shouldLoadInBackground,
		staleTickers,
	};
}

/** Load the fresh feed result, falling back to demo data only when cache is absent. */
export async function loadFreshNewsFeed({
	force = false,
	hasCachedItems = false,
	heldTickers,
	preferDemoData = false,
	staleTickers = [],
}) {
	try {
		return {
			kind: "result",
			newsResult: preferDemoData
				? await loadDemoNewsFeed(heldTickers)
				: await loadLiveNewsFeed({ heldTickers, force, staleTickers }),
			options: {
				demo: Boolean(preferDemoData),
				partialError: true,
			},
		};
	} catch (error) {
		if (hasCachedItems) {
			return {
				kind: "cached-error",
				error: new Error("Using cached news"),
				failedTickers: heldTickers,
			};
		}

		if (!preferDemoData) {
			try {
				return {
					kind: "result",
					newsResult: await loadDemoNewsFeed(heldTickers),
					options: { demo: true },
				};
			} catch {
				// Keep the original live failure below.
			}
		}

		return {
			kind: "error",
			error,
		};
	}
}
