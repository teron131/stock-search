import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONFIG } from "../config.js";
import {
	normalizeDemoNewsPayload,
	normalizePortfolioNewsSummaryPayload,
	normalizeTickerNewsPayload,
} from "../dataContract.js";
import {
	buildCacheSnapshot,
	isCacheFresh,
	isPortfolioNewsSummaryFresh,
	readPortfolioNewsSummaryCache,
	writePortfolioNewsSummaryCache,
	writeTickerNewsCache,
} from "./cache.js";
import {
	buildPortfolioNewsSummaryRequestPayload,
	filterNewsItems,
	getHeldTickers,
	mapWithConcurrency,
	mergeNewsItems,
	mergePortfolioNewsSummaryWithFallback,
	preserveVisiblePortfolioNewsSummary,
	pruneRetainedNewsItems,
	sortNewsItems,
} from "./dataModel.js";
import { buildPortfolioNewsSummary } from "./summary.js";

const LOADING_MODE_IDLE = "idle";
const LOADING_MODE_FOREGROUND = "foreground";
const LOADING_MODE_BACKGROUND = "background";

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

function shouldUseFallbackPortfolioNewsSummary({ allItems, preferDemoData }) {
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
	const [portfolioNewsSummaryResult, setPortfolioNewsSummaryResult] =
		useState(null);

	const loadInFlightRef = useRef(false);
	const portfolioNewsSummaryRequestRef = useRef(0);
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
	}, [enabled, heldTickers.length, load, portfolioLoading, resetFeed]);

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
	const fallbackPortfolioNewsSummary = useMemo(
		() => buildPortfolioNewsSummary({ rows, items: allItems }),
		[allItems, rows],
	);

	useEffect(() => {
		const requestId = portfolioNewsSummaryRequestRef.current + 1;
		portfolioNewsSummaryRequestRef.current = requestId;

		if (!enabled || heldTickers.length === 0) {
			setPortfolioNewsSummaryResult(null);
			return;
		}

		if (
			shouldUseFallbackPortfolioNewsSummary({
				allItems,
				preferDemoData,
			})
		) {
			setPortfolioNewsSummaryResult((currentPortfolioNewsSummary) =>
				preserveVisiblePortfolioNewsSummary(
					fallbackPortfolioNewsSummary,
					currentPortfolioNewsSummary,
				),
			);
			return;
		}

		const cachedSummary = readPortfolioNewsSummaryCache(heldTickerKey);
		if (cachedSummary && isPortfolioNewsSummaryFresh(cachedSummary.fetchedAt)) {
			setPortfolioNewsSummaryResult((currentPortfolioNewsSummary) =>
				preserveVisiblePortfolioNewsSummary(
					mergePortfolioNewsSummaryWithFallback(
						cachedSummary.portfolioNewsSummary,
						fallbackPortfolioNewsSummary,
					),
					currentPortfolioNewsSummary,
				),
			);
			return;
		}

		setPortfolioNewsSummaryResult((currentPortfolioNewsSummary) =>
			preserveVisiblePortfolioNewsSummary(
				fallbackPortfolioNewsSummary,
				currentPortfolioNewsSummary,
			),
		);
		const payload = buildPortfolioNewsSummaryRequestPayload(rows, allItems);

		(async () => {
			try {
				const response = await postJsonWithTimeout(
					CONFIG.endpoints.portfolioNewsSummary,
					payload,
					CONFIG.requestTimeoutMs.news,
				);
				if (portfolioNewsSummaryRequestRef.current !== requestId) {
					return;
				}
				const normalizedPortfolioNewsSummary =
					mergePortfolioNewsSummaryWithFallback(
						normalizePortfolioNewsSummaryPayload(response),
						fallbackPortfolioNewsSummary,
					);
				writePortfolioNewsSummaryCache(
					heldTickerKey,
					normalizedPortfolioNewsSummary,
					new Date().toISOString(),
				);
				setPortfolioNewsSummaryResult((currentPortfolioNewsSummary) =>
					preserveVisiblePortfolioNewsSummary(
						normalizedPortfolioNewsSummary,
						currentPortfolioNewsSummary,
					),
				);
			} catch {
				if (portfolioNewsSummaryRequestRef.current !== requestId) {
					return;
				}
				setPortfolioNewsSummaryResult((currentPortfolioNewsSummary) =>
					preserveVisiblePortfolioNewsSummary(
						fallbackPortfolioNewsSummary,
						currentPortfolioNewsSummary,
					),
				);
			}
		})();
	}, [
		allItems,
		enabled,
		fallbackPortfolioNewsSummary,
		heldTickerKey,
		heldTickers.length,
		preferDemoData,
		rows,
	]);

	const portfolioNewsSummary =
		portfolioNewsSummaryResult || fallbackPortfolioNewsSummary;

	return {
		items,
		allItems,
		portfolioNewsSummary,
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
