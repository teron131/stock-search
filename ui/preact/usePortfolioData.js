import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "https://esm.sh/preact@10.19.6/hooks";

import { CONFIG } from "./config.js";
import {
	isValidStaticPortfolioPayload,
	normalizeApiDashboardPayload,
	normalizeStaticDashboardPayload,
} from "./dataContract.js";
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

function withCacheBuster(url) {
	const cacheBuster = `_=${Date.now()}`;
	return url.includes("?") ? `${url}&${cacheBuster}` : `${url}?${cacheBuster}`;
}

async function tryFetchJson(url) {
	try {
		const res = await fetch(withCacheBuster(url));
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

async function fetchJsonWithTimeout(url, timeoutMs) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(withCacheBuster(url), {
			signal: controller.signal,
		});
		if (!res.ok) return null;
		return await res.json();
	} finally {
		clearTimeout(timeoutId);
	}
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
	return equityType === "ETF";
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

		if (isEtfLikeRow(merged)) {
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
		const cp = Number(r.change_percent) || 0;
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

function staticPathCandidates() {
	const primary = CONFIG.demoPaths.primary;
	const fallback = CONFIG.demoPaths.fallback;
	const basePaths = [primary, fallback].filter(Boolean);

	return [...new Set(basePaths)].flatMap((basePath) => {
		if (String(basePath).startsWith("/")) {
			return [basePath];
		}
		return [basePath, `/${String(basePath).replace(/^\/+/, "")}`];
	});
}

async function determineStaticBasePath() {
	const candidates = staticPathCandidates();

	for (const basePath of candidates) {
		const payload = await tryFetchJson(`${basePath}/portfolio.json`);
		if (isValidStaticPortfolioPayload(payload)) {
			return basePath;
		}
	}

	return CONFIG.demoPaths.fallback;
}

async function fetchStaticPortfolioData(basePath) {
	const [portfolioRaw, statsRaw, evalRaw] = await Promise.all([
		tryFetchJson(`${basePath}/portfolio.json`),
		tryFetchJson(`${basePath}/stats.json`),
		tryFetchJson(`${basePath}/eval.json`),
	]);

	const normalized = normalizeStaticDashboardPayload({
		portfolioPayload: portfolioRaw,
		statsPayload: statsRaw,
		evalPayload: evalRaw,
	});
	if (!normalized) {
		throw new Error("Static portfolio not found");
	}

	return normalized;
}

export function usePortfolioData() {
	const [rows, setRows] = useState([]);
	const [portfolioStats, setPortfolioStats] = useState(null);
	const [colorStandards, setColorStandards] = useState(null);
	const [generatedAt, setGeneratedAt] = useState(null);
	const [loadingMode, setLoadingMode] = useState("idle");
	const [isUsingDemoData, setIsUsingDemoData] = useState(false);
	const [lastError, setLastError] = useState(null);

	const syncInFlightRef = useRef(false);
	const demoPathRef = useRef(null);
	const syncActionRef = useRef(null);
	const realtimeClientRef = useRef(null);
	const realtimeUnsubscribersRef = useRef([]);
	const realtimeRefreshTimeoutRef = useRef(null);
	const realtimeEnabledRef = useRef(false);

	const resolveDemoPath = useCallback(async () => {
		if (demoPathRef.current) return demoPathRef.current;
		const resolved = await determineStaticBasePath();
		demoPathRef.current = resolved;
		return resolved;
	}, []);

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
		const merged = calculateRanks(mergeRows(dashData, evalData));
		setRows(merged);
		setPortfolioStats(
			dashData?.portfolio_stats && typeof dashData.portfolio_stats === "object"
				? dashData.portfolio_stats
				: null,
		);
		setGeneratedAt(
			typeof dashData?.generated_at === "string" && dashData.generated_at
				? dashData.generated_at
				: null,
		);
	}, []);

	const loadFromStatic = useCallback(async () => {
		const basePath = await resolveDemoPath();
		return fetchStaticPortfolioData(basePath);
	}, [resolveDemoPath]);

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
		const topicList = Array.isArray(realtimeConfig?.topics)
			? realtimeConfig.topics.filter(
					(topic) => typeof topic === "string" && topic.trim().length > 0,
				)
			: [];
		if (
			!realtimeConfig?.enabled ||
			!realtimeConfig?.convex_url ||
			topicList.length === 0
		) {
			return false;
		}

		const convex = await import("https://esm.sh/convex@1.32.0/browser");
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
					sync({ background: true, silent: true, scope: "all" });
				}
			}, 250);
		};

		const client = new BaseConvexClient(realtimeConfig.convex_url, triggerSync);
		const subscriptions = topicList.map((queryName) =>
			client.subscribe(queryName, {}),
		);
		realtimeUnsubscribersRef.current = subscriptions.map(
			({ unsubscribe }) => unsubscribe,
		);
		realtimeClientRef.current = client;
		realtimeEnabledRef.current = true;
		return true;
	}, []);

	const loadFromApi = useCallback(
		async ({ background = false, scope = "all" } = {}) => {
			const shouldFetchMetadata = !background;

			const standardsPromise =
				shouldFetchMetadata && !colorStandards
					? tryFetchJson(CONFIG.endpoints.colorStandards)
					: Promise.resolve(null);

			const portfolioUrl =
				scope === "all"
					? CONFIG.endpoints.portfolio
					: `${CONFIG.endpoints.portfolio}?scope=${encodeURIComponent(scope)}`;
			const timeoutMs = background
				? CONFIG.requestTimeoutMs.portfolioBackground
				: CONFIG.requestTimeoutMs.portfolioForeground;
			const rawPayload = await fetchJsonWithTimeout(portfolioUrl, timeoutMs);
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
			};
		},
		[colorStandards],
	);

	const load = useCallback(
		async ({ background = false, silent = false, scope = "all" } = {}) => {
			if (syncInFlightRef.current) return;
			if (!silent && loadingMode !== "idle") return;

			syncInFlightRef.current = true;
			if (!silent) {
				setLoadingMode(background ? "background" : "foreground");
			}
			setLastError(null);
			let shouldBackfill = false;

			try {
				if (CONFIG.isDemoMode) {
					await stopRealtimeSync();
					setIsUsingDemoData(true);
					const payload = await loadFromStatic();
					applyPayload(payload);
					return;
				}

				const { dashData, standards } = await loadFromApi({
					background,
					scope,
				});

				if (standards) {
					setColorStandards(standards);
				}

				setIsUsingDemoData(false);
				applyPayload({ dashData, evalData: {} });
				await startRealtimeSync();
				shouldBackfill = scope === "priority" && !background;
			} catch (e) {
				setLastError(e);

				if (background) {
					return;
				}

				try {
					const payload = await loadFromStatic();
					await stopRealtimeSync();
					setIsUsingDemoData(true);
					applyPayload(payload);
				} catch {
					if (!background) {
						setRows([]);
						setPortfolioStats(null);
					}
				}
			} finally {
				syncInFlightRef.current = false;
				if (!silent) {
					setLoadingMode("idle");
				}
				if (shouldBackfill) {
					setTimeout(() => {
						load({
							background: true,
							silent: false,
							scope: "portfolio_live",
						});
					}, 0);
				}
			}
		},
		[
			applyPayload,
			loadFromApi,
			loadFromStatic,
			loadingMode,
			startRealtimeSync,
			stopRealtimeSync,
		],
	);

	syncActionRef.current = load;

	useEffect(() => {
		return () => {
			stopRealtimeSync();
		};
	}, [stopRealtimeSync]);

	const patchPortfolioPosition = useCallback(
		async ({
			ticker,
			quantity,
			strategy = CONFIG.defaultStrategy,
			silent = false,
		}) => {
			const normalizedTicker = normalizeTicker(ticker);
			const normalizedQuantity = Number(quantity);
			if (!normalizedTicker || Number.isNaN(normalizedQuantity)) {
				return { ok: false, reason: "invalid" };
			}

			const res = await fetch(
				`${CONFIG.endpoints.portfolio}/${normalizedTicker}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						quantity: normalizedQuantity,
						strategy,
					}),
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
			const q = Number(quantity);
			if (!t || Number.isNaN(q)) return { ok: false, reason: "invalid" };

			if (existingQuantity != null) {
				const confirmed = window.confirm(
					`Ticker ${t} already exists with ${existingQuantity}. Update to ${q}?`,
				);
				if (!confirmed) return { ok: false, reason: "cancelled" };
			}

			return patchPortfolioPosition({
				ticker: t,
				quantity: q,
				strategy: CONFIG.defaultStrategy,
			});
		},
		[isUsingDemoData, patchPortfolioPosition],
	);

	const setQuantity = useCallback(
		async ({
			ticker,
			quantity,
			strategy = CONFIG.defaultStrategy,
			silent = false,
		}) => {
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
		async ({
			file,
			replace = true,
			strategy = CONFIG.defaultStrategy,
		} = {}) => {
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
			if (!res.ok) return { ok: false, reason: "server" };

			const payload = await res.json();
			await load({ background: false, silent: false, scope: "priority" });
			return { ok: true, payload };
		},
		[isUsingDemoData, load],
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
		isLoading: loadingMode !== "idle",
		isBackgroundLoading: loadingMode === "background",
		isUsingDemoData,
		lastError,
		stats,
		topTickers,
		actions: {
			sync: load,
			addOrUpdate,
			setQuantity,
			importFromImage,
			remove,
		},
	};
}
