import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "preact/hooks";

import { CONFIG } from "./config.js";
import { normalizeApiDashboardPayload } from "./dataContract.js";
import { normalizeTicker } from "./format.js";

const EVAL_KEYS = [
	"overall_score",
	"quality_score",
	"valuation_score",
	"moat_score",
	"upside_score",
	"market_cap_score",
	"bull_probability",
	"bear_probability",
	"rank",
];

const LOADING_MODE_IDLE = "idle";
const LOADING_MODE_FOREGROUND = "foreground";
const LOADING_MODE_BACKGROUND = "background";
const { initial: INITIAL_PORTFOLIO_SCOPE, live: LIVE_PORTFOLIO_SCOPE } =
	CONFIG.portfolioScopes;

async function tryFetchJson(url) {
	try {
		const res = await fetch(url);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

async function fetchJsonWithTimeout(url, timeoutMs, signal) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	const abortFromParent = () => controller.abort();
	if (signal?.aborted) {
		controller.abort();
	} else {
		signal?.addEventListener("abort", abortFromParent, { once: true });
	}
	try {
		const res = await fetch(url, {
			signal: controller.signal,
		});
		if (!res.ok) return null;
		return await res.json();
	} finally {
		signal?.removeEventListener("abort", abortFromParent);
		clearTimeout(timeoutId);
	}
}

function normalizeRealtimeTopics(value) {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((topic) => {
			if (typeof topic === "string" && topic.trim().length > 0) {
				return { name: topic, args: {} };
			}
			if (
				typeof topic === "object" &&
				topic !== null &&
				typeof topic.name === "string" &&
				topic.name.trim().length > 0
			) {
				return {
					name: topic.name,
					args:
						typeof topic.args === "object" && topic.args !== null
							? topic.args
							: {},
				};
			}
			return null;
		})
		.filter((topic) => topic != null);
}

function ensureEvalEntries(evalData) {
	if (evalData && typeof evalData === "object") {
		return Object.entries(evalData).map(([ticker, data]) => ({
			...data,
			ticker,
		}));
	}

	return [];
}

function isEtfLikeRow(row) {
	const equityType = String(row?.equity_type ?? "").toUpperCase();
	const quoteType = String(row?.quote_type ?? "").toUpperCase();
	return equityType === "ETF" || quoteType === "ETF";
}

function clearEtfMarketCap(row) {
	row.market_cap = null;
	row.fx = null;
}

function mergeRows(dashData, evalData) {
	const portfolioMap = new Map(
		(dashData.rows || []).map((r) => [normalizeTicker(r.ticker), r]),
	);
	const evalEntries = ensureEvalEntries(evalData);
	const evalMap = new Map(
		evalEntries.map((e) => [normalizeTicker(e.ticker), e]),
	);

	const allTickers = new Set([...portfolioMap.keys(), ...evalMap.keys()]);

	return Array.from(allTickers).map((t) => {
		const p = portfolioMap.get(t) || {};
		const e = evalMap.get(t) || {};
		const safeTicker = p.ticker || e.ticker || t;

		// API rows are authoritative for live stats; eval is fill-only.
		const merged = { ...p };
		Object.entries(e).forEach(([k, v]) => {
			if (merged[k] == null) {
				merged[k] = v;
			}
		});

		merged.ticker = safeTicker;
		merged.name = merged.name || e.name || safeTicker;

		if (merged.notional == null && !isEtfLikeRow(merged)) {
			const total = Number(merged.total);
			if (Number.isFinite(total) && total > 0) {
				merged.notional = {
					from_stocks: total,
					from_etf: 0,
					from_options: 0,
				};
			}
		}

		if (isEtfLikeRow(merged)) {
			clearEtfMarketCap(merged);
			EVAL_KEYS.forEach((key) => {
				merged[key] = null;
			});
		}

		return merged;
	});
}

function calculateRanks(rows) {
	const out = rows.map((row) => ({ ...row, rank: null }));

	const ranked = rows
		.map((row, index) => ({
			index,
			hasScore: row.overall_score != null && row.overall_score !== "",
			score: Number(row.overall_score),
		}))
		.filter((item) => item.hasScore)
		.filter((item) => Number.isFinite(item.score))
		.sort((a, b) => b.score - a.score);

	ranked.forEach((item, rank) => {
		out[item.index] = { ...out[item.index], rank: rank + 1 };
	});

	return out;
}

function calculateWeights(rows) {
	const totalVal = rows.reduce((acc, r) => acc + (Number(r.total) || 0), 0);
	if (totalVal <= 0) {
		return {
			totalVal: 0,
			rows: rows.map((r) => ({ ...r, weight_pct: 0 })),
		};
	}

	return {
		totalVal,
		rows: rows.map((r) => {
			const rawTotal = r.total;
			const total = rawTotal == null ? null : Number(rawTotal);
			if (total == null || Number.isNaN(total)) {
				return { ...r, weight_pct: null };
			}
			return { ...r, weight_pct: (total / totalVal) * 100 };
		}),
	};
}

function calculateWeightedChange(rows, totalVal) {
	if (totalVal <= 0) return { percent: 0, absolute: 0 };

	const absolute = rows.reduce((acc, r) => {
		const cp = Number(r.change_percent_1d) || 0;
		const total = Number(r.total) || 0;
		return acc + ((cp / 100) * total) / (1 + cp / 100);
	}, 0);

	const percent = (absolute / (totalVal - absolute)) * 100;
	return { percent, absolute };
}

function upsertRow(rows, nextRow) {
	const ticker = normalizeTicker(nextRow?.ticker);
	if (!ticker) return rows;

	const index = rows.findIndex(
		(row) => normalizeTicker(row?.ticker) === ticker,
	);
	if (index === -1) return [...rows, nextRow];

	const cloned = [...rows];
	cloned[index] = nextRow;
	return cloned;
}

function removeRow(rows, ticker) {
	const normalizedTicker = normalizeTicker(ticker);
	return rows.filter(
		(row) => normalizeTicker(row?.ticker) !== normalizedTicker,
	);
}

function isJsonEqual(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function setValueIfChanged(setter, nextValue, areEqual = Object.is) {
	setter((currentValue) =>
		areEqual(currentValue, nextValue) ? currentValue : nextValue,
	);
}

function getPortfolioUrl(scope) {
	if (CONFIG.isDemoMode) {
		return CONFIG.demoEndpoints.portfolio;
	}

	if (!scope || scope === "all") {
		return CONFIG.endpoints.portfolio;
	}

	return `${CONFIG.endpoints.portfolio}?scope=${encodeURIComponent(scope)}`;
}

function getLoadingMode(background) {
	return background ? LOADING_MODE_BACKGROUND : LOADING_MODE_FOREGROUND;
}

function normalizeQuantityInput(quantity) {
	if (quantity == null || String(quantity).trim() === "") {
		return 0;
	}
	const normalizedQuantity = Number(quantity);
	return Number.isFinite(normalizedQuantity) ? normalizedQuantity : null;
}

function isAbortError(error) {
	return error?.name === "AbortError";
}

function getNormalizedPortfolioStats(dashData) {
	return dashData?.portfolio_stats &&
		typeof dashData.portfolio_stats === "object"
		? dashData.portfolio_stats
		: null;
}

function getGeneratedAtTimestamp(dashData) {
	return typeof dashData?.generated_at === "string" && dashData.generated_at
		? dashData.generated_at
		: null;
}

export function usePortfolioData() {
	const [rows, setRows] = useState([]);
	const [portfolioStats, setPortfolioStats] = useState(null);
	const [colorStandards, setColorStandards] = useState(null);
	const [generatedAt, setGeneratedAt] = useState(null);
	const [loadingMode, setLoadingMode] = useState(LOADING_MODE_IDLE);
	const [syncInFlight, setSyncInFlight] = useState(false);
	const [isUsingDemoData, setIsUsingDemoData] = useState(false);
	const [lastError, setLastError] = useState(null);

	const syncInFlightRef = useRef(false);
	const syncAbortControllerRef = useRef(null);
	const syncActionRef = useRef(null);
	const realtimeClientRef = useRef(null);
	const realtimeUnsubscribersRef = useRef([]);
	const realtimeRefreshTimeoutRef = useRef(null);
	const realtimeEnabledRef = useRef(false);

	const stats = useMemo(() => {
		const { totalVal, rows: weighted } = calculateWeights(rows);
		const change = calculateWeightedChange(weighted, totalVal);
		const positions = weighted.filter((row) => Number(row.quantity) > 0).length;
		const derived = {
			totalVal,
			change,
			positions,
			weightedBeta: null,
			weightedIv: null,
			sectorDistribution: [],
		};
		if (!portfolioStats || typeof portfolioStats !== "object") {
			return derived;
		}

		const totalFromApi = Number(portfolioStats.total);
		const changeValueFromApi = Number(portfolioStats.change);
		const changePctFromApi = Number(portfolioStats.change_percent);
		const positionsFromApi = Number(
			portfolioStats.held_positions_count ?? portfolioStats.positions,
		);
		const weightedBetaFromApi = Number(portfolioStats.weighted_beta);
		const weightedIvFromApi = Number(portfolioStats.weighted_iv);

		return {
			totalVal: Number.isFinite(totalFromApi) ? totalFromApi : derived.totalVal,
			change: {
				absolute: Number.isFinite(changeValueFromApi)
					? changeValueFromApi
					: derived.change.absolute,
				percent: Number.isFinite(changePctFromApi)
					? changePctFromApi
					: derived.change.percent,
			},
			positions: Number.isFinite(positionsFromApi)
				? positionsFromApi
				: derived.positions,
			weightedBeta: Number.isFinite(weightedBetaFromApi)
				? weightedBetaFromApi
				: null,
			weightedIv: Number.isFinite(weightedIvFromApi) ? weightedIvFromApi : null,
			sectorDistribution: Array.isArray(portfolioStats.sector_distribution)
				? portfolioStats.sector_distribution
				: [],
		};
	}, [portfolioStats, rows]);

	const applyPayload = useCallback(({ dashData, evalData = {} }) => {
		const nextRows = calculateRanks(mergeRows(dashData, evalData));
		const nextPortfolioStats = getNormalizedPortfolioStats(dashData);
		const nextGeneratedAt = getGeneratedAtTimestamp(dashData);

		setValueIfChanged(setRows, nextRows, isJsonEqual);
		setValueIfChanged(setPortfolioStats, nextPortfolioStats, isJsonEqual);
		setValueIfChanged(setGeneratedAt, nextGeneratedAt);
	}, []);

	const beginSync = useCallback(() => {
		if (syncInFlightRef.current) {
			return null;
		}
		const controller = new AbortController();
		syncInFlightRef.current = true;
		syncAbortControllerRef.current = controller;
		setSyncInFlight(true);
		return controller;
	}, []);

	const finishSync = useCallback((controller) => {
		if (syncAbortControllerRef.current !== controller) return;
		syncAbortControllerRef.current = null;
		syncInFlightRef.current = false;
		setSyncInFlight(false);
	}, []);

	const cancelSync = useCallback(() => {
		const controller = syncAbortControllerRef.current;
		if (!controller || controller.signal.aborted) {
			return false;
		}
		controller.abort();
		return true;
	}, []);

	const stopRealtimeSync = useCallback(async () => {
		if (realtimeRefreshTimeoutRef.current != null) {
			clearTimeout(realtimeRefreshTimeoutRef.current);
			realtimeRefreshTimeoutRef.current = null;
		}
		realtimeUnsubscribersRef.current.forEach((unsubscribe) => {
			try {
				unsubscribe();
			} catch {
				// no-op
			}
		});
		realtimeUnsubscribersRef.current = [];
		const client = realtimeClientRef.current;
		realtimeClientRef.current = null;
		realtimeEnabledRef.current = false;
		if (client && typeof client.close === "function") {
			try {
				await client.close();
			} catch {
				// no-op
			}
		}
	}, []);

	const startRealtimeSync = useCallback(async () => {
		if (CONFIG.isDemoMode || realtimeEnabledRef.current) return false;
		const realtimeConfig = await tryFetchJson(CONFIG.endpoints.realtimeConfig);
		const topics = normalizeRealtimeTopics(realtimeConfig?.topics);
		if (
			!realtimeConfig?.enabled ||
			!realtimeConfig?.convex_url ||
			topics.length === 0
		) {
			return false;
		}

		const convex = await import("convex/browser");
		const { BaseConvexClient } = convex || {};
		if (!BaseConvexClient) {
			return false;
		}

		const triggerSync = () => {
			if (syncInFlightRef.current) return;
			if (realtimeRefreshTimeoutRef.current != null) {
				clearTimeout(realtimeRefreshTimeoutRef.current);
			}
			realtimeRefreshTimeoutRef.current = setTimeout(() => {
				const sync = syncActionRef.current;
				if (typeof sync === "function") {
					sync({
						background: true,
						silent: true,
						scope: LIVE_PORTFOLIO_SCOPE,
					});
				}
			}, 250);
		};

		const client = new BaseConvexClient(realtimeConfig.convex_url, triggerSync);
		const subscriptions = topics.map(({ name, args }) =>
			client.subscribe(name, args),
		);
		realtimeUnsubscribersRef.current = subscriptions.map(
			({ unsubscribe }) => unsubscribe,
		);
		realtimeClientRef.current = client;
		realtimeEnabledRef.current = true;
		return true;
	}, []);

	const loadFromApi = useCallback(
		async ({
			background = false,
			scope = LIVE_PORTFOLIO_SCOPE,
			signal,
		} = {}) => {
			const shouldFetchMetadata = !background;
			const timeoutMs = background
				? CONFIG.requestTimeoutMs.portfolioBackground
				: CONFIG.requestTimeoutMs.portfolioForeground;

			async function readPayload({ portfolioUrl, standardsUrl, isDemoData }) {
				const standardsPromise =
					shouldFetchMetadata && !colorStandards
						? fetchJsonWithTimeout(standardsUrl, timeoutMs, signal)
						: Promise.resolve(null);
				const rawPayload = await fetchJsonWithTimeout(
					portfolioUrl,
					timeoutMs,
					signal,
				);
				const dashData = normalizeApiDashboardPayload(rawPayload);
				if (!dashData) {
					throw new Error("API Failure");
				}

				const standardsPayload = await standardsPromise;
				const standards = standardsPayload?.standards;
				return {
					dashData,
					standards:
						standards && typeof standards === "object" ? standards : null,
					isDemoData,
				};
			}

			if (CONFIG.isDemoMode) {
				return readPayload({
					portfolioUrl: CONFIG.demoEndpoints.portfolio,
					standardsUrl: CONFIG.demoEndpoints.colorStandards,
					isDemoData: true,
				});
			}

			return readPayload({
				portfolioUrl: getPortfolioUrl(scope),
				standardsUrl: CONFIG.endpoints.colorStandards,
				isDemoData: false,
			});
		},
		[colorStandards],
	);

	const applyApiResult = useCallback(
		({ dashData, standards, isDemoData = false }) => {
			if (standards) {
				setColorStandards(standards);
			}

			setLastError(null);
			setIsUsingDemoData(Boolean(isDemoData));
			applyPayload({ dashData, evalData: {} });
		},
		[applyPayload],
	);

	const clearDashboardData = useCallback(() => {
		setRows([]);
		setPortfolioStats(null);
		setGeneratedAt(null);
	}, []);

	const loadCachedSnapshot = useCallback(async () => {
		const abortController = beginSync();
		if (!abortController) return false;

		try {
			const apiResult = await loadFromApi({
				background: false,
				scope: INITIAL_PORTFOLIO_SCOPE,
				signal: abortController.signal,
			});
			applyApiResult(apiResult);
			return true;
		} catch (error) {
			if (isAbortError(error)) {
				return "cancelled";
			}
			return false;
		} finally {
			finishSync(abortController);
		}
	}, [applyApiResult, beginSync, finishSync, loadFromApi]);

	const load = useCallback(
		async ({
			background = false,
			silent = false,
			scope = LIVE_PORTFOLIO_SCOPE,
		} = {}) => {
			if (!silent && loadingMode !== LOADING_MODE_IDLE) return;
			const abortController = beginSync();
			if (!abortController) return { ok: false, reason: "busy" };

			if (!silent) {
				setLoadingMode(getLoadingMode(background));
			}
			setLastError(null);
			try {
				const apiResult = await loadFromApi({
					background,
					scope,
					signal: abortController.signal,
				});
				applyApiResult(apiResult);
				await startRealtimeSync();
				return { ok: true };
			} catch (e) {
				if (isAbortError(e)) {
					setLastError(null);
					return { ok: false, reason: "cancelled" };
				}
				await stopRealtimeSync();
				if (!background) {
					setLastError(e);
				}
				setIsUsingDemoData(false);

				if (background) {
					return;
				}
				if (rows.length === 0) {
					clearDashboardData();
				}
				return { ok: false, reason: "failed" };
			} finally {
				finishSync(abortController);
				if (!silent) {
					setLoadingMode(LOADING_MODE_IDLE);
				}
			}
		},
		[
			applyApiResult,
			beginSync,
			clearDashboardData,
			finishSync,
			loadFromApi,
			loadingMode,
			rows.length,
			startRealtimeSync,
			stopRealtimeSync,
		],
	);

	const sync = useCallback(
		async ({
			background = false,
			silent = false,
			scope = LIVE_PORTFOLIO_SCOPE,
			preferCached = false,
		} = {}) => {
			if (preferCached) {
				const restoredCache = await loadCachedSnapshot();
				if (restoredCache === "cancelled") {
					return { ok: false, reason: "cancelled" };
				}
				return load({
					background: restoredCache,
					silent: true,
					scope,
				});
			}

			const keepCurrentRowsVisible = rows.length > 0;
			return load({
				background: background || keepCurrentRowsVisible,
				silent: silent || keepCurrentRowsVisible,
				scope,
			});
		},
		[load, loadCachedSnapshot, rows.length],
	);

	syncActionRef.current = sync;

	useEffect(() => {
		return () => {
			cancelSync();
			stopRealtimeSync();
		};
	}, [cancelSync, stopRealtimeSync]);

	const patchPortfolioPosition = useCallback(
		async ({ ticker, quantity, strategy, silent = false }) => {
			const normalizedTicker = normalizeTicker(ticker);
			const normalizedQuantity = normalizeQuantityInput(quantity);
			if (!normalizedTicker || normalizedQuantity == null) {
				return { ok: false, reason: "invalid" };
			}

			const patch = { quantity: normalizedQuantity };
			if (strategy !== undefined) {
				patch.strategy = strategy;
			}

			const res = await fetch(
				`${CONFIG.endpoints.portfolio}/${normalizedTicker}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(patch),
				},
			);

			if (!res.ok) return { ok: false, reason: "server" };
			const rowPayload = await tryFetchJson(
				CONFIG.endpoints.stockStats(normalizedTicker),
			);
			if (rowPayload?.row) {
				setRows((prevRows) =>
					calculateRanks(upsertRow(prevRows, rowPayload.row)),
				);
				setPortfolioStats(null);
				const generatedAt = rowPayload?.meta?.generated_at;
				setGeneratedAt(
					typeof generatedAt === "string" && generatedAt
						? generatedAt
						: new Date().toISOString(),
				);
				return { ok: true };
			}

			await load({ background: true, silent });
			return { ok: true, fallback: "full_reload" };
		},
		[load],
	);

	const addOrUpdate = useCallback(
		async ({ ticker, quantity, existingQuantity }) => {
			if (isUsingDemoData) return { ok: false, reason: "demo" };

			const t = normalizeTicker(ticker);
			const q = normalizeQuantityInput(quantity);
			if (!t || q == null) return { ok: false, reason: "invalid" };

			if (existingQuantity != null) {
				const confirmed = window.confirm(
					`Ticker ${t} already exists with ${existingQuantity}. Update to ${q}?`,
				);
				if (!confirmed) return { ok: false, reason: "cancelled" };
			}

			return patchPortfolioPosition({
				ticker: t,
				quantity: q,
			});
		},
		[isUsingDemoData, patchPortfolioPosition],
	);

	const setQuantity = useCallback(
		async ({ ticker, quantity, strategy, silent = false }) => {
			if (isUsingDemoData) return { ok: false, reason: "demo" };

			return patchPortfolioPosition({
				ticker,
				quantity,
				strategy,
				silent,
			});
		},
		[isUsingDemoData, patchPortfolioPosition],
	);

	const importFromImage = useCallback(
		async ({ file, replace = true, strategy } = {}) => {
			if (isUsingDemoData) return { ok: false, reason: "demo" };
			if (!(file instanceof File)) return { ok: false, reason: "invalid" };

			const formData = new FormData();
			formData.append("file", file);
			formData.append("replace", String(Boolean(replace)));
			if (strategy) {
				formData.append("strategy", strategy);
			}

			const res = await fetch(CONFIG.endpoints.portfolioImportImage, {
				method: "POST",
				body: formData,
			});
			if (!res.ok) {
				const payload = await res.json().catch(() => null);
				return {
					ok: false,
					reason: "server",
					detail:
						payload && typeof payload.detail === "string"
							? payload.detail
							: null,
				};
			}

			const payload = await res.json();
			await sync({ scope: LIVE_PORTFOLIO_SCOPE });
			return { ok: true, payload };
		},
		[isUsingDemoData, sync],
	);

	const remove = useCallback(
		async ({ ticker }) => {
			if (isUsingDemoData) return { ok: false, reason: "demo" };

			const t = normalizeTicker(ticker);
			if (!t) return { ok: false, reason: "invalid" };

			const confirmed = window.confirm(
				`CONFIRM: Eliminate ${t} from portfolio?`,
			);
			if (!confirmed) return { ok: false, reason: "cancelled" };

			const res = await fetch(`${CONFIG.endpoints.portfolio}/${t}`, {
				method: "DELETE",
			});
			if (!res.ok) return { ok: false, reason: "server" };

			setRows((prevRows) => calculateRanks(removeRow(prevRows, t)));
			setPortfolioStats(null);
			setGeneratedAt(new Date().toISOString());
			return { ok: true };
		},
		[isUsingDemoData],
	);

	const topTickers = useMemo(() => {
		return (
			[...rows]
				.sort(
					(a, b) => (Number(b.weight_pct) || 0) - (Number(a.weight_pct) || 0),
				)
				// TradingView ticker tape accepts plain tickers (no exchange prefix) and
				// resolves logos internally; keep them lowercase like the official snippet.
				.map((r) =>
					String(r?.ticker || "")
						.trim()
						.replace("-", ".")
						.toLowerCase(),
				)
				.filter(
					(t, i, self) =>
						t && t.length < CONFIG.maxTickerLength && self.indexOf(t) === i,
				)
				.slice(0, CONFIG.maxTickerTapeCount)
		);
	}, [rows]);

	return {
		rows,
		generatedAt,
		colorStandards,
		isLoading: loadingMode !== LOADING_MODE_IDLE,
		isBackgroundLoading: loadingMode === LOADING_MODE_BACKGROUND,
		isSyncing: syncInFlight,
		isUsingDemoData,
		lastError,
		stats,
		topTickers,
		actions: {
			sync,
			cancelSync,
			addOrUpdate,
			setQuantity,
			importFromImage,
			remove,
		},
	};
}
