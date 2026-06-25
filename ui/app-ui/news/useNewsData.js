/** Coordinate React state for the portfolio news feed and summary panel. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONFIG } from "../config.js";
import { normalizePortfolioNewsSummaryPayload } from "../dataContract.js";
import {
	isPortfolioNewsSummaryFresh,
	readPortfolioNewsSummaryCache,
	writePortfolioNewsSummaryCache,
} from "./cache.js";
import {
	buildPortfolioNewsSummaryRequestPayload,
	filterNewsItems,
	getHeldTickers,
	mergePortfolioNewsSummaryWithFallback,
	preserveVisiblePortfolioNewsSummary,
	sortNewsItems,
} from "./dataModel.js";
import {
	loadFreshNewsFeed,
	loadSharedNewsFeed,
	planNewsFeedLoad,
} from "./feed.js";
import { buildPortfolioNewsSummary } from "./summary.js";

const LOADING_MODE_IDLE = "idle";
const LOADING_MODE_FOREGROUND = "foreground";
const LOADING_MODE_BACKGROUND = "background";
const INITIAL_FEED_STATE = {
	allItems: [],
	generatedAt: null,
	failedTickers: [],
	isUsingDemoData: false,
	isUsingSharedNews: false,
	lastError: null,
	loadingMode: LOADING_MODE_IDLE,
};

/** Build a stable key for portfolio news summary requests and failures. */
function buildPortfolioNewsSummaryRequestKey({ heldTickerKey, allItems }) {
	return JSON.stringify({
		heldTickerKey,
		items: allItems.slice(0, 40).map((item) => ({
			url: item.url || null,
			title: item.title || null,
			summary: String(item.summary || "").slice(0, 240),
			relevancy: item.relevancy || "low",
			category: item.category || "other",
			sentiment: item.sentiment || "neutral",
			sourceTickers: item.sourceTickers || [],
		})),
	});
}

/** Request and cache a live portfolio summary merged with the local fallback summary. */
async function requestPortfolioNewsSummary({
	allItems,
	fallbackPortfolioNewsSummary,
	heldTickerKey,
	rows,
}) {
	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		CONFIG.requestTimeoutMs.news,
	);
	let responsePayload;
	try {
		const response = await fetch(CONFIG.endpoints.portfolioNewsSummarize, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(
				buildPortfolioNewsSummaryRequestPayload(rows, allItems),
			),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`Request failed: ${response.status}`);
		}
		responsePayload = await response.json();
	} finally {
		clearTimeout(timeoutId);
	}
	const portfolioNewsSummary = mergePortfolioNewsSummaryWithFallback(
		normalizePortfolioNewsSummaryPayload(responsePayload),
		fallbackPortfolioNewsSummary,
	);
	writePortfolioNewsSummaryCache(
		heldTickerKey,
		portfolioNewsSummary,
		new Date().toISOString(),
	);
	return portfolioNewsSummary;
}

/** Return portfolio news state, filters, refresh controls, and summary data for the UI. */
export function useNewsData({
	rows,
	enabled,
	portfolioLoading = false,
	preferDemoData = false,
}) {
	const [feedState, setFeedState] = useState(INITIAL_FEED_STATE);
	const [tickerFilter, setTickerFilter] = useState("ALL");
	const [relevanceFilter, setRelevanceFilter] = useState("all");
	const [portfolioNewsSummaryResult, setPortfolioNewsSummaryResult] =
		useState(null);
	const {
		allItems,
		generatedAt,
		failedTickers,
		isUsingDemoData,
		isUsingSharedNews,
		lastError,
		loadingMode,
	} = feedState;

	const loadInFlightRef = useRef(false);
	const portfolioNewsSummaryRequestRef = useRef(0);
	const portfolioNewsSummaryFailureKeyRef = useRef(null);
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
		setFeedState(INITIAL_FEED_STATE);
		portfolioNewsSummaryFailureKeyRef.current = null;
	}, []);

	const applyNewsResult = useCallback(
		(
			newsResult,
			{ demo = false, shared = false, partialError = false } = {},
		) => {
			setFeedState((currentFeedState) => ({
				...currentFeedState,
				allItems: newsResult.items,
				generatedAt: newsResult.generatedAt,
				failedTickers: newsResult.failedTickers || [],
				isUsingDemoData: demo,
				isUsingSharedNews: shared,
				lastError:
					partialError && (newsResult.failedTickers || []).length > 0
						? new Error("Partial news coverage")
						: null,
			}));
		},
		[],
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
			try {
				if (!preferDemoData && !force) {
					const sharedNews = await loadSharedNewsFeed(heldTickers).catch(
						() => null,
					);
					if (sharedNews) {
						applyNewsResult(sharedNews, { shared: true });
						if (sharedNews.portfolioNewsSummary) {
							setPortfolioNewsSummaryResult(sharedNews.portfolioNewsSummary);
						}
						return;
					}
				}

				const feedPlan = planNewsFeedLoad({
					background,
					force,
					heldTickers,
					preferDemoData,
					visibleItemCount: allItemsRef.current.length,
				});
				if (feedPlan.cachedResult) {
					applyNewsResult(feedPlan.cachedResult);
				}
				if (!feedPlan.shouldFetchFresh) {
					return;
				}
				setFeedState((currentFeedState) => ({
					...currentFeedState,
					loadingMode: feedPlan.shouldLoadInBackground
						? LOADING_MODE_BACKGROUND
						: LOADING_MODE_FOREGROUND,
				}));

				const freshNews = await loadFreshNewsFeed({
					force,
					hasCachedItems: feedPlan.hasCachedItems,
					heldTickers,
					preferDemoData,
					staleTickers: feedPlan.staleTickers,
				});
				if (freshNews.kind === "result") {
					applyNewsResult(freshNews.newsResult, freshNews.options);
				} else if (freshNews.kind === "cached-error") {
					setFeedState((currentFeedState) => ({
						...currentFeedState,
						failedTickers: freshNews.failedTickers,
						isUsingSharedNews: false,
						lastError: freshNews.error,
					}));
				} else {
					setFeedState({
						...INITIAL_FEED_STATE,
						lastError: freshNews.error,
					});
				}
			} finally {
				loadInFlightRef.current = false;
				setFeedState((currentFeedState) =>
					currentFeedState.loadingMode === LOADING_MODE_IDLE
						? currentFeedState
						: {
								...currentFeedState,
								loadingMode: LOADING_MODE_IDLE,
							},
				);
			}
		},
		[applyNewsResult, heldTickers, preferDemoData, resetFeed],
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

		if (isUsingSharedNews && portfolioNewsSummaryResult) {
			return;
		}

		if (allItems.length === 0 || CONFIG.isDemoMode || preferDemoData) {
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

		const requestKey = buildPortfolioNewsSummaryRequestKey({
			heldTickerKey,
			allItems,
		});
		if (portfolioNewsSummaryFailureKeyRef.current === requestKey) {
			return;
		}

		(async () => {
			try {
				const normalizedPortfolioNewsSummary =
					await requestPortfolioNewsSummary({
						allItems,
						fallbackPortfolioNewsSummary,
						heldTickerKey,
						rows,
					});
				if (portfolioNewsSummaryRequestRef.current !== requestId) {
					return;
				}
				portfolioNewsSummaryFailureKeyRef.current = null;
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
				portfolioNewsSummaryFailureKeyRef.current = requestKey;
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
		isUsingSharedNews,
		preferDemoData,
		portfolioNewsSummaryResult,
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
