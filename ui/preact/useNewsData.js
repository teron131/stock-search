import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "preact/hooks";

import { CONFIG } from "./config.js";
import {
	normalizeDemoNewsPayload,
	normalizeTickerNewsPayload,
} from "./dataContract.js";
import { normalizeTicker } from "./format.js";

const LOADING_MODE_IDLE = "idle";
const LOADING_MODE_FOREGROUND = "foreground";
const LOADING_MODE_BACKGROUND = "background";
const NEWS_CACHE_PREFIX = "stock-search:news-cache";

const RELEVANCE_SCORES = {
	high: 2,
	medium: 1,
	low: 0,
};

function withCacheBuster(url) {
	const cacheBuster = `_=${Date.now()}`;
	return url.includes("?") ? `${url}&${cacheBuster}` : `${url}?${cacheBuster}`;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(withCacheBuster(url), {
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

function normalizeDomain(rawDomain) {
	return String(rawDomain || "")
		.trim()
		.replace(/^www\./i, "")
		.toLowerCase();
}

function normalizeArticleUrl(url) {
	try {
		const normalizedUrl = new URL(url);
		return `${normalizedUrl.origin}${normalizedUrl.pathname}`
			.replace(/\/+$/, "")
			.toLowerCase();
	} catch {
		return String(url || "")
			.trim()
			.toLowerCase();
	}
}

function createArticleKey(article) {
	const normalizedUrl = normalizeArticleUrl(article.url);
	if (normalizedUrl) {
		return normalizedUrl;
	}

	return [
		String(article.title || "")
			.trim()
			.toLowerCase(),
		String(article.date || "")
			.trim()
			.toLowerCase(),
	]
		.filter(Boolean)
		.join("|");
}

function getPublishedTimestamp(article) {
	const publishedAt =
		article?.metadata?.published_at || article?.date || article?.metadata?.fetched_at;
	if (!publishedAt) {
		return 0;
	}

	const timestamp = Date.parse(publishedAt);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function getHeldTickers(rows) {
	const seen = new Set();
	const tickers = [];

	for (const row of Array.isArray(rows) ? rows : []) {
		const quantity = Number(row?.quantity);
		const ticker = normalizeTicker(row?.ticker);
		if (!ticker || quantity <= 0 || seen.has(ticker)) {
			continue;
		}
		seen.add(ticker);
		tickers.push(ticker);
	}

	return tickers;
}

function mergeNewsItems(items) {
	const mergedItems = new Map();

	for (const item of items) {
		const articleKey = createArticleKey(item);
		const existingItem = mergedItems.get(articleKey);
		if (!existingItem) {
			mergedItems.set(articleKey, { ...item });
			continue;
		}

		const sourceTickers = Array.from(
			new Set([
				...(existingItem.sourceTickers || []),
				...(item.sourceTickers || []),
				existingItem.sourceTicker,
				item.sourceTicker,
			].filter(Boolean)),
		);
		const preferredItem =
			getPublishedTimestamp(item) > getPublishedTimestamp(existingItem)
				? item
				: existingItem;

		mergedItems.set(articleKey, {
			...existingItem,
			...preferredItem,
			summary:
				(item.summary || "").length > (existingItem.summary || "").length
					? item.summary
					: existingItem.summary,
			relevancy:
				RELEVANCE_SCORES[item.relevancy] >
				RELEVANCE_SCORES[existingItem.relevancy]
					? item.relevancy
					: existingItem.relevancy,
			sourceTicker: sourceTickers[0] || preferredItem.sourceTicker,
			sourceTickers,
			metadata: {
				...existingItem.metadata,
				...preferredItem.metadata,
				source_domain:
					normalizeDomain(preferredItem.metadata?.source_domain) ||
					normalizeDomain(existingItem.metadata?.source_domain) ||
					null,
			},
		});
	}

	return Array.from(mergedItems.values()).sort((left, right) => {
		const timestampDiff = getPublishedTimestamp(right) - getPublishedTimestamp(left);
		if (timestampDiff !== 0) {
			return timestampDiff;
		}

		const relevanceDiff =
			RELEVANCE_SCORES[right.relevancy] - RELEVANCE_SCORES[left.relevancy];
		if (relevanceDiff !== 0) {
			return relevanceDiff;
		}

		return String(left.title || "").localeCompare(String(right.title || ""));
	});
}

async function mapWithConcurrency(items, concurrency, mapper) {
	const results = new Array(items.length);
	let nextIndex = 0;

	async function runWorker() {
		while (nextIndex < items.length) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			results[currentIndex] = await mapper(items[currentIndex], currentIndex);
		}
	}

	const workerCount = Math.min(Math.max(concurrency, 1), items.length || 1);
	await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
	return results;
}

function filterNewsItems(items, { tickerFilter, relevanceFilter }) {
	return items.filter((item) => {
		const matchesTicker =
			tickerFilter === "ALL" ||
			(item.sourceTickers || []).includes(tickerFilter) ||
			item.sourceTicker === tickerFilter;
		const matchesRelevance =
			relevanceFilter === "all" ||
			(relevanceFilter === "high" && item.relevancy === "high");

		return matchesTicker && matchesRelevance;
	});
}

function getNewsCacheKey(ticker) {
	return `${NEWS_CACHE_PREFIX}:${ticker}`;
}

function readTickerNewsCache(ticker) {
	if (typeof window === "undefined" || !window.localStorage) {
		return null;
	}

	try {
		const rawValue = window.localStorage.getItem(getNewsCacheKey(ticker));
		if (!rawValue) {
			return null;
		}

		const parsedValue = JSON.parse(rawValue);
		const fetchedAt =
			typeof parsedValue?.fetched_at === "string" && parsedValue.fetched_at
				? parsedValue.fetched_at
				: null;
		if (!fetchedAt) {
			return null;
		}

		return {
			ticker,
			fetchedAt,
			items: normalizeTickerNewsPayload(parsedValue.items, ticker),
		};
	} catch {
		return null;
	}
}

function writeTickerNewsCache(ticker, items, fetchedAt) {
	if (typeof window === "undefined" || !window.localStorage) {
		return;
	}

	try {
		window.localStorage.setItem(
			getNewsCacheKey(ticker),
			JSON.stringify({
				fetched_at: fetchedAt,
				items,
			}),
		);
	} catch {
		// Ignore storage failures and continue with in-memory state.
	}
}

function isCacheFresh(fetchedAt) {
	const fetchedTimestamp = Date.parse(fetchedAt || "");
	if (!Number.isFinite(fetchedTimestamp)) {
		return false;
	}

	return Date.now() - fetchedTimestamp < CONFIG.newsCacheTtlMs;
}

function buildCacheSnapshot(heldTickers) {
	const cacheEntries = heldTickers
		.map((ticker) => readTickerNewsCache(ticker))
		.filter(Boolean);
	const cacheEntryMap = new Map(
		cacheEntries.map((entry) => [entry.ticker, entry]),
	);

	return {
		cacheEntries,
		cacheEntryMap,
		items: mergeNewsItems(
			cacheEntries.flatMap((cacheEntry) => cacheEntry.items || []),
		),
		generatedAt:
			cacheEntries
				.map((cacheEntry) => cacheEntry.fetchedAt)
				.sort()
				.at(-1) || null,
	};
}

export function useNewsData({
	rows,
	enabled,
	portfolioLoading = false,
	preferDemoData = false,
}) {
	const [allItems, setAllItems] = useState([]);
	const [tickerFilter, setTickerFilter] = useState("ALL");
	const [relevanceFilter, setRelevanceFilter] = useState("all");
	const [generatedAt, setGeneratedAt] = useState(null);
	const [failedTickers, setFailedTickers] = useState([]);
	const [isUsingDemoData, setIsUsingDemoData] = useState(false);
	const [lastError, setLastError] = useState(null);
	const [loadingMode, setLoadingMode] = useState(LOADING_MODE_IDLE);

	const loadInFlightRef = useRef(false);
	const allItemsRef = useRef(allItems);
	const heldTickers = useMemo(() => getHeldTickers(rows), [rows]);
	const heldTickerKey = heldTickers.join("|");

	useEffect(() => {
		allItemsRef.current = allItems;
	}, [allItems]);

	const resetFeed = useCallback(() => {
		setAllItems([]);
		setGeneratedAt(null);
		setFailedTickers([]);
		setLastError(null);
		setIsUsingDemoData(false);
		setLoadingMode(LOADING_MODE_IDLE);
	}, []);

	const loadDemoNews = useCallback(async () => {
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
	}, [heldTickers]);

	const loadLiveNews = useCallback(
		async ({ force = false, staleTickers = [] } = {}) => {
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
						const items = normalizeTickerNewsPayload(payload, ticker);
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
		},
		[heldTickers],
	);

	const load = useCallback(
		async ({ background = false, force = false } = {}) => {
			if (loadInFlightRef.current) {
				return;
			}
			if (heldTickers.length === 0) {
				resetFeed();
				return;
			}

			loadInFlightRef.current = true;
			const cacheSnapshot = preferDemoData ? null : buildCacheSnapshot(heldTickers);
			const hasCachedItems = Boolean(cacheSnapshot?.items.length);
			const staleTickers = preferDemoData
				? []
				: heldTickers.filter((ticker) => {
						const cacheEntry = cacheSnapshot?.cacheEntryMap.get(ticker);
						return !cacheEntry || !isCacheFresh(cacheEntry.fetchedAt);
					});
			const shouldFetchLive = !preferDemoData && (force || staleTickers.length > 0);
			if (hasCachedItems) {
				setAllItems(cacheSnapshot.items);
				setGeneratedAt(cacheSnapshot.generatedAt);
				setFailedTickers([]);
				setLastError(null);
				setIsUsingDemoData(false);
			}
			if (!preferDemoData && !shouldFetchLive) {
				loadInFlightRef.current = false;
				setLoadingMode(LOADING_MODE_IDLE);
				return;
			}
			setLoadingMode(
				background || allItemsRef.current.length > 0 || hasCachedItems
					? LOADING_MODE_BACKGROUND
					: LOADING_MODE_FOREGROUND,
			);

			try {
				const newsResult = preferDemoData
					? await loadDemoNews()
					: await loadLiveNews({ force, staleTickers });
				setAllItems(newsResult.items);
				setGeneratedAt(newsResult.generatedAt);
				setFailedTickers(newsResult.failedTickers || []);
				setIsUsingDemoData(Boolean(preferDemoData));
				setLastError(
					(newsResult.failedTickers || []).length > 0
						? new Error("Partial news coverage")
						: null,
				);
			} catch (error) {
				if (hasCachedItems) {
					setFailedTickers(heldTickers);
					setLastError(new Error("Using cached news snapshot"));
					return;
				}

				if (!preferDemoData) {
					try {
						const demoResult = await loadDemoNews();
						setAllItems(demoResult.items);
						setGeneratedAt(demoResult.generatedAt);
						setFailedTickers([]);
						setIsUsingDemoData(true);
						setLastError(null);
						return;
					} catch {
						// Keep the original live failure below.
					}
				}

				setAllItems([]);
				setGeneratedAt(null);
				setFailedTickers([]);
				setIsUsingDemoData(false);
				setLastError(error);
			} finally {
				loadInFlightRef.current = false;
				setLoadingMode(LOADING_MODE_IDLE);
			}
		},
		[heldTickers, loadDemoNews, loadLiveNews, preferDemoData, resetFeed],
	);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		if (portfolioLoading && heldTickers.length === 0) {
			return;
		}
		if (heldTickers.length === 0) {
			resetFeed();
			return;
		}

		load();
	}, [enabled, heldTickerKey, heldTickers.length, load, portfolioLoading, resetFeed]);

	useEffect(() => {
		if (tickerFilter === "ALL" || heldTickers.includes(tickerFilter)) {
			return;
		}
		setTickerFilter("ALL");
	}, [heldTickers, tickerFilter]);

	const items = useMemo(
		() => filterNewsItems(allItems, { tickerFilter, relevanceFilter }),
		[allItems, relevanceFilter, tickerFilter],
	);

	return {
		items,
		allItems,
		tickerFilter,
		setTickerFilter,
		relevanceFilter,
		setRelevanceFilter,
		heldTickers,
		failedTickers,
		generatedAt,
		isLoading: loadingMode !== LOADING_MODE_IDLE,
		isRefreshing: loadingMode === LOADING_MODE_BACKGROUND,
		isWaitingOnPortfolio: enabled && portfolioLoading && heldTickers.length === 0,
		isUsingDemoData,
		lastError,
		refresh: load,
	};
}
