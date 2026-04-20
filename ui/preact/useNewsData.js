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
	normalizePortfolioNewsSummaryPayload,
	normalizeTickerNewsPayload,
} from "./dataContract.js";
import { normalizeTicker } from "./format.js";
import { buildPortfolioNewsSummary } from "./newsSummary.js";

const LOADING_MODE_IDLE = "idle";
const LOADING_MODE_FOREGROUND = "foreground";
const LOADING_MODE_BACKGROUND = "background";
const NEWS_CACHE_PREFIX = "stock-search:news-cache";

const RELEVANCE_SCORES = {
	high: 2,
	medium: 1,
	low: 0,
};

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

async function postJsonWithTimeout(url, payload, timeoutMs) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
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
		article?.metadata?.published_at ||
		article?.date ||
		article?.metadata?.fetched_at;
	if (!publishedAt) {
		return 0;
	}

	const timestamp = Date.parse(publishedAt);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortNewsItems(items) {
	return [...items].sort((left, right) => {
		const timestampDiff =
			getPublishedTimestamp(right) - getPublishedTimestamp(left);
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
			new Set(
				[
					...(existingItem.sourceTickers || []),
					...(item.sourceTickers || []),
					existingItem.sourceTicker,
					item.sourceTicker,
				].filter(Boolean),
			),
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

	return sortNewsItems(Array.from(mergedItems.values()));
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

function normalizeSummaryRequestRow(row) {
	return {
		ticker: normalizeTicker(row?.ticker),
		quantity: Number(row?.quantity),
		total: Number(row?.total),
		weight_pct: Number(row?.weight_pct),
	};
}

function normalizeSummaryRequestItem(item) {
	return {
		title: item.title || null,
		summary: item.summary || "",
		relevancy: item.relevancy || "low",
		category: item.category || "other",
		sentiment: item.sentiment || "neutral",
		source_tickers: (item.sourceTickers || [])
			.map(normalizeTicker)
			.filter(Boolean),
	};
}

function buildPortfolioSummaryRequestPayload(rows, items) {
	return {
		rows: rows.map((row) => normalizeSummaryRequestRow(row)),
		items: items.map((item) => normalizeSummaryRequestItem(item)),
	};
}

function shouldUseFallbackPortfolioSummary({ allItems, preferDemoData }) {
	return allItems.length === 0 || CONFIG.isDemoMode || preferDemoData;
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
	const [portfolioSummaryResult, setPortfolioSummaryResult] = useState(null);

	const loadInFlightRef = useRef(false);
	const summaryRequestRef = useRef(0);
	const allItemsRef = useRef(allItems);
	const heldTickerKey = useMemo(() => getHeldTickers(rows).join("|"), [rows]);
	const heldTickers = useMemo(
		() => (heldTickerKey ? heldTickerKey.split("|") : []),
		[heldTickerKey],
	);

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
			const cacheSnapshot = preferDemoData
				? null
				: buildCacheSnapshot(heldTickers);
			const hasCachedItems = Boolean(cacheSnapshot?.items.length);
			const staleTickers = preferDemoData
				? []
				: heldTickers.filter((ticker) => {
						const cacheEntry = cacheSnapshot?.cacheEntryMap.get(ticker);
						return !cacheEntry || !isCacheFresh(cacheEntry.fetchedAt);
					});
			const shouldFetchLive =
				!preferDemoData && (force || staleTickers.length > 0);
			const shouldHydrateFromCache =
				hasCachedItems &&
				(!background || allItemsRef.current.length === 0 || Boolean(force));
			if (shouldHydrateFromCache) {
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
	}, [
		enabled,
		heldTickerKey,
		heldTickers.length,
		load,
		portfolioLoading,
		resetFeed,
	]);

	useEffect(() => {
		if (tickerFilter === "ALL" || heldTickers.includes(tickerFilter)) {
			return;
		}
		setTickerFilter("ALL");
	}, [heldTickers, tickerFilter]);

	const items = useMemo(
		() =>
			sortNewsItems(
				filterNewsItems(allItems, { tickerFilter, relevanceFilter }),
			),
		[allItems, relevanceFilter, tickerFilter],
	);
	const fallbackPortfolioSummary = useMemo(
		() => buildPortfolioNewsSummary({ rows, items: allItems }),
		[allItems, rows],
	);

	useEffect(() => {
		const requestId = summaryRequestRef.current + 1;
		summaryRequestRef.current = requestId;

		if (!enabled || heldTickers.length === 0) {
			setPortfolioSummaryResult(null);
			return;
		}

		if (
			shouldUseFallbackPortfolioSummary({
				allItems,
				preferDemoData,
			})
		) {
			setPortfolioSummaryResult(fallbackPortfolioSummary);
			return;
		}

		setPortfolioSummaryResult(fallbackPortfolioSummary);
		const payload = buildPortfolioSummaryRequestPayload(rows, allItems);

		(async () => {
			try {
				const response = await postJsonWithTimeout(
					CONFIG.endpoints.portfolioNewsSummary,
					payload,
					CONFIG.requestTimeoutMs.news,
				);
				if (summaryRequestRef.current !== requestId) {
					return;
				}
				setPortfolioSummaryResult(
					normalizePortfolioNewsSummaryPayload(response) ||
						fallbackPortfolioSummary,
				);
			} catch {
				if (summaryRequestRef.current !== requestId) {
					return;
				}
				setPortfolioSummaryResult(fallbackPortfolioSummary);
			}
		})();
	}, [
		allItems,
		enabled,
		fallbackPortfolioSummary,
		heldTickerKey,
		heldTickers.length,
		preferDemoData,
		rows,
	]);

	const portfolioSummary = portfolioSummaryResult || fallbackPortfolioSummary;

	return {
		items,
		allItems,
		portfolioSummary,
		tickerFilter,
		setTickerFilter,
		relevanceFilter,
		setRelevanceFilter,
		heldTickers,
		failedTickers,
		generatedAt,
		isLoading: loadingMode !== LOADING_MODE_IDLE,
		isRefreshing: loadingMode === LOADING_MODE_BACKGROUND,
		isWaitingOnPortfolio:
			enabled && portfolioLoading && heldTickers.length === 0,
		isUsingDemoData,
		lastError,
		refresh: load,
	};
}
