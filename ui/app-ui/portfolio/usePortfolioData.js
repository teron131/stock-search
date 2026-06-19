import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CONFIG } from "../config.js";
import { normalizeTicker } from "../format.js";
import { buildTradingViewTickerTapeSymbols } from "../tradingViewSymbols.js";
import {
	getLoadingMode,
	isAbortError,
	LOADING_MODE_BACKGROUND,
	LOADING_MODE_IDLE,
	normalizeQuantityInput,
	readPortfolioPayload,
	tryFetchJson,
} from "./api.js";
import {
	calculatePortfolioSummary,
	calculateRanks,
	getGeneratedAtTimestamp,
	getNormalizedPortfolioStats,
	mergeRows,
	removeRow,
	upsertRow,
} from "./dataModel.js";

const { initial: INITIAL_PORTFOLIO_SCOPE, live: LIVE_PORTFOLIO_SCOPE } =
	CONFIG.portfolioScopes;

function isJsonEqual(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function setValueIfChanged(setter, nextValue, areEqual = Object.is) {
	setter((currentValue) =>
		areEqual(currentValue, nextValue) ? currentValue : nextValue,
	);
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

	const stats = useMemo(
		() => calculatePortfolioSummary(rows, portfolioStats),
		[portfolioStats, rows],
	);

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
			const apiResult = await readPortfolioPayload({
				background: false,
				colorStandards,
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
	}, [applyApiResult, beginSync, colorStandards, finishSync]);

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
				const apiResult = await readPortfolioPayload({
					background,
					colorStandards,
					scope,
					signal: abortController.signal,
				});
				applyApiResult(apiResult);
				return { ok: true };
			} catch (e) {
				if (isAbortError(e)) {
					setLastError(null);
					return { ok: false, reason: "cancelled" };
				}
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
			colorStandards,
			finishSync,
			loadingMode,
			rows.length,
		],
	);

	const refreshAfterPortfolioMutation = useCallback(async () => {
		cancelSync();
		try {
			const apiResult = await readPortfolioPayload({
				background: true,
				colorStandards,
				scope: LIVE_PORTFOLIO_SCOPE,
			});
			applyApiResult(apiResult);
			return { ok: true };
		} catch (error) {
			if (!isAbortError(error)) {
				setLastError(error);
			}
			return { ok: false, reason: "refresh_failed" };
		}
	}, [applyApiResult, cancelSync, colorStandards]);

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

	useEffect(() => {
		return () => {
			cancelSync();
		};
	}, [cancelSync]);

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
		async ({ file, strategy } = {}) => {
			if (isUsingDemoData) return { ok: false, reason: "demo" };
			if (!(file instanceof File)) return { ok: false, reason: "invalid" };

			const formData = new FormData();
			formData.append("file", file);
			if (strategy) {
				formData.append("strategy", strategy);
			}

			let res;
			try {
				res = await fetch(CONFIG.endpoints.portfolioImportImage, {
					method: "POST",
					body: formData,
				});
			} catch (error) {
				return {
					ok: false,
					reason: "server",
					detail:
						error instanceof Error
							? `Image import request failed: ${error.message}`
							: "Image import request failed.",
				};
			}
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
			const refreshed = await refreshAfterPortfolioMutation();
			return refreshed.ok
				? { ok: true, payload }
				: { ok: false, reason: refreshed.reason, payload };
		},
		[isUsingDemoData, refreshAfterPortfolioMutation],
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
		const weightedRows = [...rows].sort(
			(a, b) => (Number(b.weight_pct) || 0) - (Number(a.weight_pct) || 0),
		);
		return buildTradingViewTickerTapeSymbols(weightedRows, {
			limit: CONFIG.maxTickerTapeCount,
			maxLength: CONFIG.maxTickerLength,
		});
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
