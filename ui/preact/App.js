import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { DataTable } from "./components/DataTable.js";
import { IndustryView } from "./components/IndustryView.js";
import { QuickAdd } from "./components/QuickAdd.js";
import { CONFIG, DEFAULT_SORT_COLS } from "./config.js";
import { fmt } from "./format.js";
import { getIconDefinition, getNavIconName } from "./industryIcons.js";
import { useIndustryData } from "./useIndustryData.js";
import { usePortfolioData } from "./usePortfolioData.js";
import { getPathForView, getViewForPath } from "./viewRoutes.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const DASHBOARD_VIEW = "dashboard";
const INDUSTRY_VIEW = "industry";
const MARKETMAP_VIEW = "marketmap";
const CALENDAR_VIEW = "calendar";
const BACKGROUND_SYNC_INTERVAL_MS = 180_000;

const VIEW_TITLES = {
	[DASHBOARD_VIEW]: "DASHBOARD",
	[INDUSTRY_VIEW]: "INDUSTRY",
	[MARKETMAP_VIEW]: "MARKET MAP",
	[CALENDAR_VIEW]: "ECONOMIC CALENDAR",
};

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
		return `LAST UPDATED: --${modeText}`;
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
		second: "2-digit",
	});

	return `LAST UPDATED: ${dateStr} ${timeStr}${modeText}`;
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

function showActionError(reason) {
	if (reason === "demo") showToast("Demo Mode: Changes not saved.");
	if (reason === "invalid") showToast("INVALID_QTY");
	if (reason === "server") showToast("UPDATE FAILED");
}

async function importImageFile(file, importImageRef) {
	if (!file) return;
	setText("import-status", "IMPORTING...");
	const res = await importImageRef.current?.({
		file,
		replace: true,
		strategy: CONFIG.defaultStrategy,
	});
	if (!res?.ok) {
		showActionError(res?.reason);
		setText("import-status", "IMPORT FAILED");
		return;
	}
	const isReplace = Boolean(res?.payload?.replace);
	const appliedCount = Number(res?.payload?.applied_count || 0);
	if (appliedCount > 0) {
		showToast(`IMPORTED ${appliedCount}`);
		setText(
			"import-status",
			isReplace ? `REPLACED ${appliedCount}` : `IMPORTED ${appliedCount}`,
		);
	} else {
		showToast("NO HOLDINGS FOUND");
		setText("import-status", "NO HOLDINGS");
	}
}

function updateTickerTape(tickers) {
	const tape = document.getElementById("ticker-tape-widget");
	if (!tape) return;

	if (!tickers.length) {
		tape.setAttribute("symbols", "");
		return;
	}

	const symbols = tickers
		.map((ticker) =>
			String(ticker || "")
				.trim()
				.toLowerCase(),
		)
		.filter(Boolean)
		.join(",");

	tape.setAttribute("symbols", symbols);
	tape.style.height = "auto";
}

function createIconSvgElement(iconName, className) {
	const iconDefinition = getIconDefinition(iconName);
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "1.3");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	if (className) {
		svg.setAttribute("class", className);
	}

	iconDefinition.paths.forEach((pathValue) => {
		const path = document.createElementNS(SVG_NS, "path");
		path.setAttribute("d", pathValue);
		svg.append(path);
	});

	return svg;
}

function decorateNavItems(navItems) {
	navItems.forEach((button) => {
		if (button.dataset.iconReady === "true") return;

		const label = String(button.textContent || "").trim();
		const iconName = getNavIconName(button.dataset.view);
		button.textContent = "";
		button.append(createIconSvgElement(iconName));

		const labelSpan = document.createElement("span");
		labelSpan.textContent = label;
		button.append(labelSpan);
		button.dataset.iconReady = "true";
	});
}

function syncNavItems(viewName) {
	document.querySelectorAll(".nav-item").forEach((navItem) => {
		navItem.classList.toggle("active", navItem.dataset.view === viewName);
	});
}

function syncViewLayout(view) {
	setText("view-title", VIEW_TITLES[view] ?? VIEW_TITLES[DASHBOARD_VIEW]);

	const isDashboard = view === DASHBOARD_VIEW;
	const showsPreactRoot = isDashboard || view === INDUSTRY_VIEW;

	const preactRoot = document.getElementById("preact-root");
	if (preactRoot) {
		preactRoot.style.display = showsPreactRoot ? "block" : "none";
	}

	setDisplay("heatmap-section", view === MARKETMAP_VIEW ? "block" : "none");
	setDisplay("calendar-section", view === CALENDAR_VIEW ? "block" : "none");
	setDisplay("stats-strip", isDashboard ? "flex" : "none");
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

function renderIndustryScreen(industryData) {
	return html`
		<${IndustryView}
			isLoading=${industryData.isLoading}
			lastError=${industryData.lastError}
			sectorOptions=${industryData.sectorOptions}
			selectedSector=${industryData.selectedSector}
			setSelectedSector=${industryData.setSelectedSector}
			sortKey=${industryData.sortKey}
			sortDirection=${industryData.sortDirection}
			setSortKey=${industryData.setSortKey}
			filteredIndustries=${industryData.sortedIndustries}
		/>
	`;
}

function renderDashboardScreen({
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
	onAddOrUpdate,
}) {
	return html`
		<div class="tabs-container" id="dashboard-tables">
			<div class="dashboard-summary">
				<div class="dashboard-summary-actions">
					<${QuickAdd}
						rows=${rows}
						isUsingDemoData=${isUsingDemoData}
						onSubmit=${onAddOrUpdate}
					/>
				</div>
			</div>
			<div class="tabs-header">
				<div class="tab-group">
					<button
						type="button"
						class=${`tab-btn ${tab === "all" ? "active" : ""}`}
						onClick=${() => onTabChange("all")}
					>
						ALL
					</button>
					<button
						type="button"
						class=${`tab-btn ${tab === "holdings" ? "active" : ""}`}
						onClick=${() => onTabChange("holdings")}
					>
						PORTFOLIO
					</button>
					<button
						type="button"
						class=${`tab-btn ${tab === "evaluations" ? "active" : ""}`}
						onClick=${() => onTabChange("evaluations")}
					>
						EVALUATION
					</button>
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
				animateRows=${!isBackgroundLoading}
			/>
		</div>
	`;
}

function initSidebarAndNav({ onViewChange }) {
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

	const navItems = document.querySelectorAll(".nav-item");
	decorateNavItems(navItems);
	navItems.forEach((btn) => {
		const onClick = () => {
			const viewName = btn.dataset.view;
			if (!viewName) return;
			onViewChange(viewName);

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

export function App() {
	const [view, setView] = useState(() =>
		getViewForPath(window.location.pathname),
	);
	const [tab, setTab] = useState("all");
	const [sortCol, setSortCol] = useState(DEFAULT_SORT_COLS.all);
	const [sortDir, setSortDir] = useState("desc");

	const {
		rows,
		generatedAt,
		colorStandards,
		isLoading,
		isBackgroundLoading,
		isUsingDemoData,
		lastError,
		stats,
		topTickers,
		actions,
	} = usePortfolioData();

	const industryData = useIndustryData({ enabled: view === INDUSTRY_VIEW });

	const syncRef = useRef(actions.sync);
	const importImageRef = useRef(actions.importFromImage);
	const industryRefreshRef = useRef(industryData.refresh);
	const viewRef = useRef(view);

	useEffect(() => {
		syncRef.current = actions.sync;
	}, [actions.sync]);

	useEffect(() => {
		importImageRef.current = actions.importFromImage;
	}, [actions.importFromImage]);

	useEffect(() => {
		industryRefreshRef.current = industryData.refresh;
	}, [industryData.refresh]);

	useEffect(() => {
		viewRef.current = view;
	}, [view]);

	useEffect(() => {
		const nextPath = getPathForView(view);
		if (!CONFIG.isDemoMode && window.location.pathname !== nextPath) {
			window.history.pushState({}, "", nextPath);
		}
		syncNavItems(view);
	}, [view]);

	useEffect(() => {
		if (CONFIG.isDemoMode) {
			return undefined;
		}

		const onPopState = () => {
			setView(getViewForPath(window.location.pathname));
		};

		window.addEventListener("popstate", onPopState);
		return () => {
			window.removeEventListener("popstate", onPopState);
		};
	}, []);

	useEffect(() => {
		const cleanupSidebar = initSidebarAndNav({ onViewChange: setView });
		const cleanupHeatmapTabs = initHeatmapTabs();
		createCalendarWidget();
		actions.sync({
			scope: CONFIG.portfolioScopes.live,
			preferCached: true,
		});

		const refreshBtn = document.getElementById("refresh-btn");
		const importBtn = document.getElementById("import-image-btn");
		const importInput = document.getElementById("import-image-input");

		const onRefresh = () => {
			if (viewRef.current === INDUSTRY_VIEW) {
				industryRefreshRef.current?.();
				return;
			}
			syncRef.current?.({ scope: CONFIG.portfolioScopes.live });
		};
		const onImportClick = () => importInput?.click();
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
			cleanupHeatmapTabs?.();
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
		syncViewLayout(view);
	}, [view]);

	const activeTimestamp =
		view === INDUSTRY_VIEW ? industryData.meta.fetched_at : generatedAt;
	const activeIsUsingDemoData =
		view === DASHBOARD_VIEW ? isUsingDemoData : false;

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
		if (industryData.lastError && !industryData.isLoading) {
			showToast("INDUSTRY SNAPSHOT FAILED");
		}
	}, [industryData.isLoading, industryData.lastError]);

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

	if (view === INDUSTRY_VIEW) {
		return renderIndustryScreen(industryData);
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
		onAddOrUpdate,
	});
}
