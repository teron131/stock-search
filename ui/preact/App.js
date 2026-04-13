import { html } from "https://esm.sh/htm@3.1.1/preact";
import {
	useEffect,
	useRef,
	useState,
} from "https://esm.sh/preact@10.19.6/hooks";

import { DataTable } from "./components/DataTable.js";
import { QuickAdd } from "./components/QuickAdd.js";
import { CONFIG, DEFAULT_SORT_COLS } from "./config.js";
import { fmt } from "./format.js";
import { usePortfolioData } from "./usePortfolioData.js";

const VIEW_TITLES = {
	dashboard: "DASHBOARD",
	heatmap: "MARKET MAP",
	calendar: "ECONOMIC CALENDAR",
};

function setText(id, value) {
	const el = document.getElementById(id);
	if (el) el.textContent = value;
}

function setDisplay(id, display) {
	const el = document.getElementById(id);
	if (el) el.style.display = display;
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
	const container = document.getElementById("ticker-tape-view");
	if (!tape || !container) return;

	if (!tickers.length) {
		tape.setAttribute("symbols", "");
		container.style.display = "none";
		return;
	}

	container.style.display = "block";

	// TradingView ticker tape expects a comma-separated list of symbols.
	const symbols = tickers
		.map((t) =>
			String(t || "")
				.trim()
				.toLowerCase(),
		)
		.filter(Boolean)
		.join(",");

	tape.setAttribute("symbols", symbols);
	tape.style.height = "auto";
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
	navItems.forEach((btn) => {
		const onClick = () => {
			const viewName = btn.dataset.view;
			if (!viewName) return;

			navItems.forEach((n) => {
				n.classList.toggle("active", n.dataset.view === viewName);
			});
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

			tabs.forEach((t) => {
				t.classList.toggle("active", t.dataset.source === source);
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
	const [view, setView] = useState("dashboard");
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

	const syncRef = useRef(actions.sync);
	const importImageRef = useRef(actions.importFromImage);
	useEffect(() => {
		syncRef.current = actions.sync;
	}, [actions.sync]);
	useEffect(() => {
		importImageRef.current = actions.importFromImage;
	}, [actions.importFromImage]);

	// Initial boot
	useEffect(() => {
		const cleanupSidebar = initSidebarAndNav({ onViewChange: setView });
		const cleanupHeatmapTabs = initHeatmapTabs();
		createCalendarWidget();
		actions.sync({ background: false, scope: "priority" });

		const refreshBtn = document.getElementById("refresh-btn");
		const onRefresh = () => actions.sync({ background: false });
		const importBtn = document.getElementById("import-image-btn");
		const importInput = document.getElementById("import-image-input");
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

	// Periodic background refresh (skip demo mode)
	useEffect(() => {
		if (CONFIG.isDemoMode) return;

		const intervalId = setInterval(() => {
			if (document.visibilityState !== "visible" || !navigator.onLine) return;
			syncRef.current?.({
				background: true,
				silent: false,
				scope: "portfolio_live",
			});
		}, 180_000);

		return () => {
			clearInterval(intervalId);
		};
	}, []);

	// View toggles (keep TradingView embeds mounted)
	useEffect(() => {
		setText("view-title", VIEW_TITLES[view] ?? VIEW_TITLES.calendar);

		const isDashboard = view === "dashboard";

		const preactRoot = document.getElementById("preact-root");
		if (preactRoot) preactRoot.style.display = isDashboard ? "block" : "none";

		setDisplay("heatmap-section", view === "heatmap" ? "block" : "none");
		setDisplay("calendar-section", view === "calendar" ? "block" : "none");

		// Ticker tape is only for dashboard. In Preact, updating standard display sometimes conflicts
		// with TradingView widget life cycles, so we force visibility hidden as well if necessary,
		// or rely on strict display:none to hide the whole container safely.
		const tapeView = document.getElementById("ticker-tape-view");
		if (tapeView) {
			if (isDashboard) {
				tapeView.style.display = "block";
				tapeView.style.visibility = "visible";
				tapeView.style.height = "auto";
			} else {
				tapeView.style.display = "none";
				tapeView.style.visibility = "hidden";
				tapeView.style.height = "0";
			}
		}

		setDisplay("stats-strip", isDashboard ? "flex" : "none");
	}, [view]);

	// Update stats strip + timestamp
	useEffect(() => {
		setText(
			"total-positions",
			stats.positions ? String(stats.positions) : "--",
		);
		setText(
			"total-value",
			stats.totalVal > 0 ? fmt.currency(stats.totalVal) : "--",
		);

		if (stats.totalVal > 0) {
			const { percent, absolute } = stats.change;
			const sign = absolute >= 0 ? "+" : "";
			const absFormatted = sign + fmt.currency(Math.abs(absolute));
			const pctFormatted = fmt.percent(percent);
			setText("portfolio-change", `${absFormatted} (${pctFormatted})`);

			const trend = document.getElementById("portfolio-change");
			if (trend) {
				trend.className = `stats-value stats-trend ${percent > 0 ? "positive" : percent < 0 ? "negative" : "neutral"}`;
			}
		} else {
			setText("portfolio-change", "--");
		}

		const modeText = isUsingDemoData ? " [DEMO]" : "";

		if (isBackgroundLoading) {
			setText("last-update", `UPDATING...${modeText}`);
			return;
		}

		// last updated
		if (!generatedAt) {
			setText("last-update", `LAST UPDATED: --${modeText}`);
			return;
		}

		const time = new Date(generatedAt);
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

		setText("last-update", `LAST UPDATED: ${dateStr} ${timeStr}${modeText}`);
	}, [generatedAt, isUsingDemoData, isBackgroundLoading, stats]);

	// Update ticker tape
	useEffect(() => {
		updateTickerTape(topTickers);
	}, [topTickers]);

	// Loading overlay (only for foreground loads)
	useEffect(() => {
		const overlay = document.getElementById("loading-overlay");
		if (!overlay) return;

		const show = isLoading && !isBackgroundLoading;

		// Show overlay only for foreground sync actions; background refresh stays unobtrusive.
		overlay.style.display = show ? "flex" : "none";
		document.body.classList.toggle("is-loading", show);

		return () => {
			document.body.classList.remove("is-loading");
		};
	}, [isLoading, isBackgroundLoading]);

	useEffect(() => {
		if (lastError && !isLoading) {
			showToast("SYNCHRONIZATION FAILED");
		}
	}, [lastError, isLoading]);

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

	return html`
    <div class="tabs-container" id="dashboard-tables">
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
        <${QuickAdd}
          rows=${rows}
          isUsingDemoData=${isUsingDemoData}
          onSubmit=${onAddOrUpdate}
        />
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
