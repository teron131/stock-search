import { html } from "htm/react";
import { useEffect, useRef, useState } from "react";
import { TableSection } from "./components/table/Section.js";
import { CONFIG, DEFAULT_SORT_COLS } from "./config.js";
import { useNewsData } from "./news/useNewsData.js";
import { NewsView } from "./news/View.js";
import { usePortfolioData } from "./portfolio/usePortfolioData.js";
import { useSectorData } from "./sectors/useSectorData.js";
import { SectorView } from "./sectors/View.js";
import {
	buildAuthLoginUrl,
	CALENDAR_VIEW,
	DASHBOARD_VIEW,
	fetchAuthSession,
	fetchRuntimeConfig,
	formatLastUpdatedText,
	importImageFile,
	initSidebarAndNav,
	MARKETMAP_VIEW,
	NEWS_VIEW,
	SECTORS_VIEW,
	setText,
	showActionError,
	showToast,
	syncLogoutButton,
	syncRefreshButtonState,
	syncViewLayout,
	updatePortfolioSummary,
} from "./shell/dom.js";
import {
	createCalendarWidget,
	initHeatmapTabs,
	updateTickerTape,
} from "./shell/tradingView.js";

const BACKGROUND_SYNC_INTERVAL_MS = 180_000;
const NEWS_BACKGROUND_SYNC_INTERVAL_MS = CONFIG.newsAutoRefreshIntervalMs;

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

export function App({ initialView = DASHBOARD_VIEW }) {
	const view = initialView;
	const [tab, setTab] = useState("all");
	const [sortCol, setSortCol] = useState(DEFAULT_SORT_COLS.all);
	const [sortDir, setSortDir] = useState("desc");
	const [showPortfolioStats, setShowPortfolioStats] = useState(false);
	const [tickerSearchQuery, setTickerSearchQuery] = useState("");

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

	return html`<${TableSection}
		tab=${tab}
		rows=${rows}
		sortCol=${sortCol}
		sortDir=${sortDir}
		onTabChange=${onTabChange}
		onSort=${onSort}
		onRemove=${onRemove}
		onSetQuantity=${onSetQuantity}
		colorStandards=${colorStandards}
		isUsingDemoData=${isUsingDemoData}
		isBackgroundLoading=${isBackgroundLoading}
		isLoading=${isLoading}
		onAddOrUpdate=${onAddOrUpdate}
		onTickerSearchChange=${setTickerSearchQuery}
		tickerSearchQuery=${tickerSearchQuery}
	/>`;
}
