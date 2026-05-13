import { html } from "htm/react";
import { useEffect, useRef, useState } from "react";
import { DataTable } from "./components/DataTable.js";
import { NewsView } from "./components/NewsView.js";
import { QuickAdd } from "./components/QuickAdd.js";
import { SectorView } from "./components/SectorView.js";
import { CONFIG, DEFAULT_SORT_COLS } from "./config.js";
import { fmt } from "./format.js";
import { useNewsData } from "./useNewsData.js";
import { usePortfolioData } from "./usePortfolioData.js";
import { useSectorData } from "./useSectorData.js";

const DASHBOARD_VIEW = "dashboard";
const NEWS_VIEW = "news";
const SECTORS_VIEW = "sectors";
const MARKETMAP_VIEW = "marketmap";
const CALENDAR_VIEW = "calendar";
const BACKGROUND_SYNC_INTERVAL_MS = 180_000;
const NEWS_BACKGROUND_SYNC_INTERVAL_MS = CONFIG.newsAutoRefreshIntervalMs;

const VIEW_TITLES = {
	[DASHBOARD_VIEW]: "DASHBOARD",
	[NEWS_VIEW]: "NEWS",
	[SECTORS_VIEW]: "SECTORS",
	[MARKETMAP_VIEW]: "MARKET MAP",
	[CALENDAR_VIEW]: "ECONOMIC CALENDAR",
};
const TICKER_TAPE_SCRIPT_SRC =
	"https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js";
const TICKER_TAPE_PLACEHOLDER_HTML =
	'<div class="tradingview-widget-container__widget"></div>';
const TICKER_TAPE_RETRY_DELAY_MS = 6_000;
const TICKER_TAPE_OPTIONS = {
	showSymbolLogo: true,
	isTransparent: true,
	displayMode: "compact",
	colorTheme: "dark",
	locale: "en",
};

let tickerTapeRetryId = null;

function setText(id, value) {
	const el = document.getElementById(id);
	if (el) el.textContent = value;
}

function setDisplay(id, display) {
	const el = document.getElementById(id);
	if (el) el.style.display = display;
}

function formatLastUpdatedText(timestamp, { isUsingDemoData = false } = {}) {
	const modeText = isUsingDemoData ? " [DEMO]" : "";
	if (!timestamp) {
		return `UPDATED --${modeText}`;
	}

	const time = new Date(timestamp);
	const dateStr = time.toLocaleDateString("en-US", {
		month: "short",
		day: "2-digit",
	});
	const timeStr = time.toLocaleTimeString("en-US", {
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
	});

	return `UPDATED ${dateStr} ${timeStr}${modeText}`;
}

function showToast(message) {
	const toast = document.createElement("div");
	toast.className = "toast";
	toast.textContent = message;
	document.body.appendChild(toast);

	setTimeout(() => {
		toast.classList.add("toast-fade");
		setTimeout(() => toast.remove(), 500);
	}, 3000);
}

function showActionError(reason, detail = null) {
	if (reason === "demo") showToast("Demo Mode: Changes not saved.");
	if (reason === "invalid") showToast("INVALID_QTY");
	if (reason === "server") showToast(detail || "UPDATE FAILED");
}

function buildAuthLoginUrl() {
	const nextPath = `${window.location.pathname}${window.location.search}`;
	return `${CONFIG.endpoints.authLogin}?next=${encodeURIComponent(nextPath)}`;
}

async function fetchAuthSession() {
	try {
		const response = await fetch(CONFIG.endpoints.authSession);
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

async function fetchRuntimeConfig() {
	if (CONFIG.isDemoMode) return null;
	try {
		const response = await fetch(CONFIG.endpoints.realtimeConfig);
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

function syncButtonTooltip(button, tooltip) {
	button.setAttribute("aria-label", tooltip);
	button.dataset.tooltip = tooltip;
	button.removeAttribute("title");
}

function syncLogoutButton(authSession) {
	const logoutBtn = document.getElementById("logout-btn");
	if (!logoutBtn) return;

	const shouldShow =
		!CONFIG.isDemoMode &&
		Boolean(authSession?.enabled) &&
		Boolean(authSession?.authenticated);

	logoutBtn.hidden = !shouldShow;
	const tooltip =
		shouldShow && authSession?.email
			? `Logout (${authSession.email})`
			: "Logout";
	syncButtonTooltip(logoutBtn, tooltip);
}

async function importImageFile(file, importImageRef) {
	if (!file) return;
	setText("import-status", "IMPORTING...");
	const res = await importImageRef.current?.({
		file,
	});
	if (!res?.ok) {
		showActionError(res?.reason, res?.detail);
		setText("import-status", "IMPORT FAILED");
		return;
	}
	const appliedCount = Number(res?.payload?.applied_count || 0);
	if (appliedCount > 0) {
		showToast(`UPDATED ${appliedCount}`);
		setText("import-status", `UPDATED ${appliedCount}`);
	} else {
		showToast("NO HOLDINGS FOUND");
		setText("import-status", "NO HOLDINGS");
	}
}

function updateTickerTape(tickers) {
	const container = document.getElementById("ticker-tape-widget");
	if (!container) return;

	const symbols = tickers.filter(Boolean);
	const symbolsKey = symbols.join(",");
	if (hasLoadedTickerTape(container, symbolsKey)) {
		return;
	}

	window.clearTimeout(tickerTapeRetryId);
	container.dataset.symbols = symbolsKey;
	container.innerHTML = TICKER_TAPE_PLACEHOLDER_HTML;

	if (!symbols.length) {
		return;
	}

	container.appendChild(createTickerTapeScript(symbols));
	tickerTapeRetryId = window.setTimeout(() => {
		if (!shouldRetryTickerTape(container, symbolsKey)) return;
		container.dataset.symbols = "";
		updateTickerTape(symbols);
	}, TICKER_TAPE_RETRY_DELAY_MS);
}

function hasLoadedTickerTape(container, symbolsKey) {
	return (
		container.dataset.symbols === symbolsKey &&
		Boolean(container.querySelector("iframe"))
	);
}

function shouldRetryTickerTape(container, symbolsKey) {
	return (
		container.dataset.symbols === symbolsKey &&
		!container.querySelector("iframe")
	);
}

function createTickerTapeScript(symbols) {
	const script = document.createElement("script");
	script.type = "text/javascript";
	script.src = TICKER_TAPE_SCRIPT_SRC;
	script.async = true;
	script.innerHTML = JSON.stringify({
		symbols: symbols.map((symbol) => ({
			proName: symbol.toUpperCase(),
			title: symbol.toUpperCase(),
		})),
		...TICKER_TAPE_OPTIONS,
	});
	return script;
}

function syncViewLayout(view, { showPortfolioStats = false } = {}) {
	setText("view-title", VIEW_TITLES[view] ?? VIEW_TITLES[DASHBOARD_VIEW]);

	const isDashboard = view === DASHBOARD_VIEW;
	const showsAppRoot =
		isDashboard || view === SECTORS_VIEW || view === NEWS_VIEW;

	const appRoot = document.getElementById("app-root");
	if (appRoot) {
		appRoot.style.display = showsAppRoot ? "block" : "none";
	}

	setDisplay("heatmap-section", view === MARKETMAP_VIEW ? "block" : "none");
	setDisplay("calendar-section", view === CALENDAR_VIEW ? "block" : "none");
	setDisplay(
		"stats-strip",
		isDashboard && showPortfolioStats ? "flex" : "none",
	);
	setDisplay("import-image-btn", isDashboard ? "inline-flex" : "none");
	setDisplay("import-status", isDashboard ? "inline" : "none");

	const tapeView = document.getElementById("ticker-tape-view");
	if (!tapeView) return;

	if (isDashboard) {
		tapeView.style.display = "block";
		tapeView.style.visibility = "visible";
		tapeView.style.height = "auto";
		return;
	}

	tapeView.style.display = "none";
	tapeView.style.visibility = "hidden";
	tapeView.style.height = "0";
}

function getRefreshIconMarkup(isSyncing) {
	if (isSyncing) {
		return `<svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="4.5" width="7" height="7" rx="1"></rect></svg>`;
	}
	return `<svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M12.8 5.3A4.8 4.8 0 0 0 4.2 6.9"></path><path d="M12.8 3.2v2.1h-2.1"></path><path d="M3.2 10.7a4.8 4.8 0 0 0 8.6-1.6"></path><path d="M3.2 12.8v-2.1h2.1"></path></svg>`;
}

function syncRefreshButtonState({
	view,
	isPortfolioSyncing,
	isSectorLoading,
	isNewsLoading,
}) {
	const refreshBtn = document.getElementById("refresh-btn");
	const syncStatus = document.getElementById("sync-status");
	const isDashboardSyncing = view === DASHBOARD_VIEW && isPortfolioSyncing;
	const isViewLoading =
		isDashboardSyncing ||
		(view === SECTORS_VIEW && isSectorLoading) ||
		(view === NEWS_VIEW && isNewsLoading);

	if (syncStatus) {
		syncStatus.textContent = isViewLoading ? "SYNCING..." : "";
	}
	if (!refreshBtn) return;

	refreshBtn.classList.toggle("is-syncing", isDashboardSyncing);
	refreshBtn.dataset.icon = isDashboardSyncing ? "stop" : "sync";
	refreshBtn.innerHTML = getRefreshIconMarkup(isDashboardSyncing);
	syncButtonTooltip(refreshBtn, isDashboardSyncing ? "Stop syncing" : "Sync");
	refreshBtn.setAttribute(
		"aria-pressed",
		isDashboardSyncing ? "true" : "false",
	);
}

function updatePortfolioSummary(stats) {
	setText("total-positions", stats.positions ? String(stats.positions) : "--");
	setText(
		"total-value",
		stats.totalVal > 0 ? fmt.currency(stats.totalVal) : "--",
	);

	if (stats.totalVal <= 0) {
		setText("portfolio-change", "--");
		return;
	}

	const { percent, absolute } = stats.change;
	const sign = absolute >= 0 ? "+" : "";
	const absoluteText = sign + fmt.currency(Math.abs(absolute));
	const percentText = fmt.percent(percent);
	setText("portfolio-change", `${absoluteText} (${percentText})`);

	const trend = document.getElementById("portfolio-change");
	if (!trend) return;

	trend.className = `stats-value stats-trend ${
		percent > 0 ? "positive" : percent < 0 ? "negative" : "neutral"
	}`;
}

function renderSectorScreen(sectorData) {
	return html`
		<${SectorView}
			isLoading=${sectorData.isLoading}
			lastError=${sectorData.lastError}
			sortKey=${sectorData.sortKey}
			sortDirection=${sectorData.sortDirection}
			setSortKey=${sectorData.setSortKey}
			filteredSectors=${sectorData.sortedSectors}
		/>
	`;
}

function renderNewsScreen(newsData) {
	return html`
		<${NewsView}
			items=${newsData.items}
			portfolioNewsSummary=${newsData.portfolioNewsSummary}
			tickerFilter=${newsData.tickerFilter}
			setTickerFilter=${newsData.setTickerFilter}
			relevanceFilter=${newsData.relevanceFilter}
			setRelevanceFilter=${newsData.setRelevanceFilter}
			heldTickers=${newsData.heldTickers}
			failedTickers=${newsData.failedTickers}
			isLoading=${newsData.isLoading}
			isRefreshing=${newsData.isRefreshing}
			isWaitingOnPortfolio=${newsData.isWaitingOnPortfolio}
			lastError=${newsData.lastError}
		/>
	`;
}

function renderDashboardScreen({
	tab,
	rows,
	sortCol,
	sortDir,
	onTabChange,
	onSort,
	onRemove,
	onSetQuantity,
	colorStandards,
	isUsingDemoData,
	isBackgroundLoading,
	isLoading,
	onAddOrUpdate,
}) {
	return html`
		<div className="tabs-container" id="dashboard-tables">
			<div className="tabs-header">
				<div className="tab-group">
					<button
						type="button"
						className=${`tab-btn ${tab === "all" ? "active" : ""}`}
						onClick=${() => onTabChange("all")}
					>
						ALL
					</button>
					<button
						type="button"
						className=${`tab-btn ${tab === "holdings" ? "active" : ""}`}
						onClick=${() => onTabChange("holdings")}
					>
						PORTFOLIO
					</button>
					<button
						type="button"
						className=${`tab-btn ${tab === "evaluations" ? "active" : ""}`}
						onClick=${() => onTabChange("evaluations")}
					>
						EVALUATION
					</button>
				</div>
				<div className="dashboard-tabs-actions">
					<${QuickAdd}
						rows=${rows}
						isUsingDemoData=${isUsingDemoData}
						onSubmit=${onAddOrUpdate}
					/>
				</div>
			</div>

			<${DataTable}
				tab=${tab}
				rows=${rows}
				sortCol=${sortCol}
				sortDir=${sortDir}
				onSort=${onSort}
				onRemove=${onRemove}
				onSetQuantity=${onSetQuantity}
				colorStandards=${colorStandards}
				isUsingDemoData=${isUsingDemoData}
				isLoading=${isLoading}
				animateRows=${!isBackgroundLoading}
			/>
		</div>
	`;
}

function initSidebarAndNav() {
	const sidebar = document.getElementById("sidebar");
	const toggle = document.getElementById("sidebar-toggle");
	const cleanupFns = [];

	const toggleSidebar = () => {
		if (sidebar) sidebar.classList.toggle("collapsed");
	};

	if (toggle) {
		toggle.addEventListener("click", toggleSidebar);
		cleanupFns.push(() => toggle.removeEventListener("click", toggleSidebar));
	}

	if (window.innerWidth <= 1024) {
		const topBarLeft = document.querySelector(".top-bar-left");
		if (topBarLeft) {
			topBarLeft.addEventListener("click", toggleSidebar);
			cleanupFns.push(() =>
				topBarLeft.removeEventListener("click", toggleSidebar),
			);
		}
	}

	document.querySelectorAll(".nav-item").forEach((btn) => {
		const onClick = () => {
			if (window.innerWidth <= 1024 && sidebar) {
				sidebar.classList.add("collapsed");
			}
		};
		btn.addEventListener("click", onClick);
		cleanupFns.push(() => btn.removeEventListener("click", onClick));
	});

	return () => {
		cleanupFns.forEach((cleanup) => {
			cleanup();
		});
	};
}

function createHeatmapWidget(dataSource) {
	const container = document.getElementById("heatmap-widget-container");
	if (!container) return;

	container.innerHTML =
		'<div class="tradingview-widget-container__widget"></div>';
	const script = document.createElement("script");
	script.type = "text/javascript";
	script.src =
		"https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js";
	script.async = true;
	script.innerHTML = JSON.stringify({ ...CONFIG.heatmapWidget, dataSource });
	container.appendChild(script);
}

function createCalendarWidget() {
	const container = document.getElementById("calendar-widget-container");
	if (!container) return;

	container.innerHTML =
		'<div class="tradingview-widget-container__widget"></div>';
	const script = document.createElement("script");
	script.type = "text/javascript";
	script.src =
		"https://s3.tradingview.com/external-embedding/embed-widget-events.js";
	script.async = true;
	script.innerHTML = JSON.stringify({
		colorTheme: "dark",
		isTransparent: false,
		locale: "en",
		countryFilter: "us",
		importanceFilter: "-1,0,1",
		width: "100%",
		height: "100%",
	});
	container.appendChild(script);
}

function initHeatmapTabs() {
	const tabs = document.querySelectorAll("#heatmap-section .tab-btn");
	const cleanupFns = [];
	createHeatmapWidget("SPX500");

	tabs.forEach((tab) => {
		const onClick = () => {
			const source = tab.dataset.source;
			if (!source) return;

			tabs.forEach((tabButton) => {
				tabButton.classList.toggle(
					"active",
					tabButton.dataset.source === source,
				);
			});
			createHeatmapWidget(source);
		};

		tab.addEventListener("click", onClick);
		cleanupFns.push(() => tab.removeEventListener("click", onClick));
	});

	return () => {
		cleanupFns.forEach((cleanup) => {
			cleanup();
		});
	};
}

export function App({ initialView = DASHBOARD_VIEW }) {
	const view = initialView;
	const [tab, setTab] = useState("all");
	const [sortCol, setSortCol] = useState(DEFAULT_SORT_COLS.all);
	const [sortDir, setSortDir] = useState("desc");
	const [showPortfolioStats, setShowPortfolioStats] = useState(false);

	const {
		rows,
		generatedAt,
		colorStandards,
		isLoading,
		isBackgroundLoading,
		isSyncing,
		isUsingDemoData,
		lastError,
		stats,
		topTickers,
		actions,
	} = usePortfolioData();

	const sectorData = useSectorData({ enabled: view === SECTORS_VIEW });
	const newsData = useNewsData({
		rows,
		enabled: view === NEWS_VIEW,
		portfolioLoading: isLoading,
		preferDemoData: isUsingDemoData,
	});

	const syncRef = useRef(actions.sync);
	const cancelSyncRef = useRef(actions.cancelSync);
	const portfolioSyncingRef = useRef(isSyncing);
	const importImageRef = useRef(actions.importFromImage);
	const sectorRefreshRef = useRef(sectorData.refresh);
	const newsRefreshRef = useRef(newsData.refresh);
	const viewRef = useRef(view);

	useEffect(() => {
		syncRef.current = actions.sync;
	}, [actions.sync]);

	useEffect(() => {
		cancelSyncRef.current = actions.cancelSync;
	}, [actions.cancelSync]);

	useEffect(() => {
		portfolioSyncingRef.current = isSyncing;
	}, [isSyncing]);

	useEffect(() => {
		importImageRef.current = actions.importFromImage;
	}, [actions.importFromImage]);

	useEffect(() => {
		sectorRefreshRef.current = sectorData.refresh;
	}, [sectorData.refresh]);

	useEffect(() => {
		newsRefreshRef.current = newsData.refresh;
	}, [newsData.refresh]);

	useEffect(() => {
		viewRef.current = view;
	}, [view]);

	useEffect(() => {
		if (view !== MARKETMAP_VIEW) return undefined;
		return initHeatmapTabs();
	}, [view]);

	useEffect(() => {
		if (view === CALENDAR_VIEW) createCalendarWidget();
	}, [view]);

	useEffect(() => {
		const cleanupSidebar = initSidebarAndNav();

		const refreshBtn = document.getElementById("refresh-btn");
		const importBtn = document.getElementById("import-image-btn");
		const importInput = document.getElementById("import-image-input");
		const logoutBtn = document.getElementById("logout-btn");

		const onRefresh = () => {
			if (viewRef.current === SECTORS_VIEW) {
				sectorRefreshRef.current?.();
				return;
			}
			if (viewRef.current === NEWS_VIEW) {
				newsRefreshRef.current?.({ force: true });
				return;
			}
			if (portfolioSyncingRef.current) {
				cancelSyncRef.current?.();
				return;
			}
			syncRef.current?.({ scope: CONFIG.portfolioScopes.live });
		};
		const onImportClick = () => importInput?.click();
		const onLogout = () => {
			window.location.assign(CONFIG.endpoints.authLogout);
		};
		const onImportChange = async (event) => {
			const file = event?.target?.files?.[0];
			if (!file) return;
			await importImageFile(file, importImageRef);
			event.target.value = "";
		};
		const onImportDragEnter = (event) => {
			event.preventDefault();
			event.stopPropagation();
			importBtn?.classList.add("drag-over");
		};
		const onImportDragOver = (event) => {
			event.preventDefault();
			event.stopPropagation();
			importBtn?.classList.add("drag-over");
		};
		const onImportDragLeave = (event) => {
			event.preventDefault();
			event.stopPropagation();
			importBtn?.classList.remove("drag-over");
		};
		const onImportDrop = async (event) => {
			event.preventDefault();
			event.stopPropagation();
			importBtn?.classList.remove("drag-over");
			const file = event?.dataTransfer?.files?.[0];
			if (!file) return;
			if (!String(file.type || "").startsWith("image/")) {
				showToast("PLEASE DROP AN IMAGE");
				return;
			}
			await importImageFile(file, importImageRef);
		};

		void (async () => {
			const authSession = await fetchAuthSession();
			syncLogoutButton(authSession);
			if (
				!CONFIG.isDemoMode &&
				authSession?.enabled &&
				!authSession?.authenticated
			) {
				window.location.assign(buildAuthLoginUrl());
				return;
			}
			syncRef.current?.({
				scope: CONFIG.portfolioScopes.live,
				preferCached: true,
			});
		})();

		if (logoutBtn) {
			logoutBtn.addEventListener("click", onLogout);
		}
		if (refreshBtn) {
			refreshBtn.addEventListener("click", onRefresh);
		}
		if (importBtn) {
			importBtn.addEventListener("click", onImportClick);
			importBtn.addEventListener("dragenter", onImportDragEnter);
			importBtn.addEventListener("dragover", onImportDragOver);
			importBtn.addEventListener("dragleave", onImportDragLeave);
			importBtn.addEventListener("drop", onImportDrop);
		}
		if (importInput) {
			importInput.addEventListener("change", onImportChange);
		}

		return () => {
			cleanupSidebar?.();
			if (logoutBtn) {
				logoutBtn.removeEventListener("click", onLogout);
			}
			if (refreshBtn) {
				refreshBtn.removeEventListener("click", onRefresh);
			}
			if (importBtn) {
				importBtn.removeEventListener("click", onImportClick);
				importBtn.removeEventListener("dragenter", onImportDragEnter);
				importBtn.removeEventListener("dragover", onImportDragOver);
				importBtn.removeEventListener("dragleave", onImportDragLeave);
				importBtn.removeEventListener("drop", onImportDrop);
				importBtn.classList.remove("drag-over");
			}
			if (importInput) {
				importInput.removeEventListener("change", onImportChange);
			}
		};
	}, []);

	useEffect(() => {
		let isActive = true;
		void (async () => {
			const runtimeConfig = await fetchRuntimeConfig();
			if (isActive) {
				setShowPortfolioStats(Boolean(runtimeConfig?.show_portfolio_stats));
			}
		})();
		return () => {
			isActive = false;
		};
	}, []);

	useEffect(() => {
		if (CONFIG.isDemoMode) return;

		const intervalId = setInterval(() => {
			if (viewRef.current !== DASHBOARD_VIEW) return;
			if (document.visibilityState !== "visible" || !navigator.onLine) return;
			syncRef.current?.({ scope: CONFIG.portfolioScopes.live });
		}, BACKGROUND_SYNC_INTERVAL_MS);

		return () => {
			clearInterval(intervalId);
		};
	}, []);

	useEffect(() => {
		if (CONFIG.isDemoMode) return;

		const intervalId = setInterval(() => {
			if (viewRef.current !== NEWS_VIEW) return;
			if (document.visibilityState !== "visible" || !navigator.onLine) return;
			newsRefreshRef.current?.({ background: true });
		}, NEWS_BACKGROUND_SYNC_INTERVAL_MS);

		return () => {
			clearInterval(intervalId);
		};
	}, []);

	useEffect(() => {
		syncViewLayout(view, { showPortfolioStats });
	}, [showPortfolioStats, view]);

	useEffect(() => {
		syncRefreshButtonState({
			view,
			isPortfolioSyncing: isSyncing,
			isSectorLoading: sectorData.isLoading,
			isNewsLoading: newsData.isLoading,
		});
	}, [sectorData.isLoading, isSyncing, newsData.isLoading, view]);

	const activeTimestamp =
		view === SECTORS_VIEW
			? sectorData.meta.fetched_at
			: view === NEWS_VIEW
				? newsData.generatedAt
				: generatedAt;
	const activeIsUsingDemoData =
		view === DASHBOARD_VIEW
			? isUsingDemoData
			: view === NEWS_VIEW
				? newsData.isUsingDemoData
				: false;

	useEffect(() => {
		setText(
			"last-update",
			formatLastUpdatedText(activeTimestamp, {
				isUsingDemoData: activeIsUsingDemoData,
			}),
		);
	}, [activeIsUsingDemoData, activeTimestamp]);

	useEffect(() => {
		updatePortfolioSummary(stats);
	}, [stats]);

	useEffect(() => {
		updateTickerTape(topTickers);
	}, [topTickers]);

	useEffect(() => {
		if (lastError && !isLoading && view === DASHBOARD_VIEW) {
			showToast("SYNCHRONIZATION FAILED");
		}
	}, [isLoading, lastError, view]);

	useEffect(() => {
		if (sectorData.lastError && !sectorData.isLoading) {
			showToast("SECTOR SNAPSHOT FAILED");
		}
	}, [sectorData.isLoading, sectorData.lastError]);

	useEffect(() => {
		if (
			view === NEWS_VIEW &&
			newsData.lastError &&
			!newsData.isLoading &&
			newsData.items.length === 0
		) {
			showToast("NEWS FEED FAILED");
		}
	}, [newsData.isLoading, newsData.items.length, newsData.lastError, view]);

	const onSort = (key) => {
		const isSame = sortCol === key;
		setSortDir(isSame && sortDir === "asc" ? "desc" : "asc");
		setSortCol(key);
	};

	const onTabChange = (nextTab) => {
		setTab(nextTab);
		setSortCol(DEFAULT_SORT_COLS[nextTab] ?? DEFAULT_SORT_COLS.all);
		setSortDir("desc");
	};

	const onRemove = async (ticker) => {
		const res = await actions.remove({ ticker });
		if (res.ok) showToast("UPDATED");
		showActionError(res.reason);
	};

	const onSetQuantity = async ({
		ticker,
		quantity,
		strategy,
		silent = false,
	}) => {
		const res = await actions.setQuantity({
			ticker,
			quantity,
			strategy,
			silent,
		});

		if (!res.ok) {
			showActionError(res.reason);
			return res;
		}

		if (!silent) {
			showToast("UPDATED");
		}

		return res;
	};

	const onAddOrUpdate = async ({ ticker, quantity, existingQuantity }) => {
		const res = await actions.addOrUpdate({
			ticker,
			quantity,
			existingQuantity,
		});
		if (!res.ok) {
			showActionError(res.reason);
			return res;
		}
		showToast("UPDATED");
		return res;
	};

	if (view === NEWS_VIEW) {
		return renderNewsScreen(newsData);
	}

	if (view === SECTORS_VIEW) {
		return renderSectorScreen(sectorData);
	}

	if (view === MARKETMAP_VIEW || view === CALENDAR_VIEW) {
		return null;
	}

	return renderDashboardScreen({
		stats,
		tab,
		rows,
		sortCol,
		sortDir,
		onTabChange,
		onSort,
		onRemove,
		onSetQuantity,
		colorStandards,
		isUsingDemoData,
		isBackgroundLoading,
		isLoading,
		onAddOrUpdate,
	});
}
