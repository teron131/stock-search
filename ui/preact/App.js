import { html } from "https://esm.sh/htm@3.1.1/preact";
import { useEffect, useState } from "https://esm.sh/preact@10.19.6/hooks";

import { DataTable } from "./components/DataTable.js";
import { QuickAdd } from "./components/QuickAdd.js";
import { CONFIG, DEFAULT_SORT_COLS } from "./config.js";
import { fmt } from "./format.js";
import { usePortfolioData } from "./usePortfolioData.js";

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
  tape.setAttribute("symbols", tickers.join(","));
  tape.style.height = "auto";
}

function initSidebarAndNav({ onViewChange }) {
  const sidebar = document.getElementById("sidebar");
  const toggle = document.getElementById("sidebar-toggle");

  const toggleSidebar = () => {
    if (sidebar) sidebar.classList.toggle("collapsed");
  };

  if (toggle) {
    toggle.addEventListener("click", toggleSidebar);
  }

  if (window.innerWidth <= 1024) {
    const topBarLeft = document.querySelector(".top-bar-left");
    if (topBarLeft) topBarLeft.addEventListener("click", toggleSidebar);
  }

  const navItems = document.querySelectorAll(".nav-item");
  navItems.forEach((btn) => {
    btn.addEventListener("click", () => {
      const viewName = btn.dataset.view;
      if (!viewName) return;

      navItems.forEach((n) => n.classList.toggle("active", n.dataset.view === viewName));
      onViewChange(viewName);

      if (window.innerWidth <= 1024 && sidebar) {
        sidebar.classList.add("collapsed");
      }
    });
  });
}

function createHeatmapWidget(dataSource) {
  const container = document.getElementById("heatmap-widget-container");
  if (!container) return;

  container.innerHTML = '<div class="tradingview-widget-container__widget"></div>';
  const script = document.createElement("script");
  script.type = "text/javascript";
  script.src = "https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js";
  script.async = true;
  script.innerHTML = JSON.stringify({ ...CONFIG.heatmapWidget, dataSource });
  container.appendChild(script);
}

function initHeatmapTabs() {
  const tabs = document.querySelectorAll("#heatmap-section .tab-btn");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const source = tab.dataset.source;
      if (!source) return;

      tabs.forEach((t) => t.classList.toggle("active", t.dataset.source === source));
      createHeatmapWidget(source);
    });
  });
}

export function App() {
  const [view, setView] = useState("dashboard");
  const [tab, setTab] = useState("holdings");
  const [sortCol, setSortCol] = useState(DEFAULT_SORT_COLS.holdings);
  const [sortDir, setSortDir] = useState("desc");

  const {
    rows,
    generatedAt,
    isLoading,
    isBackgroundLoading,
    isUsingDemoData,
    lastError,
    stats,
    topTickers,
    actions,
  } = usePortfolioData();

  // Initial boot
  useEffect(() => {
    initSidebarAndNav({ onViewChange: setView });
    initHeatmapTabs();
    actions.sync({ background: false });

    const refreshBtn = document.getElementById("refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => actions.sync({ background: false }));
    }
  }, []);

  // View toggles (keep TradingView embeds mounted)
  useEffect(() => {
    setText("view-title", view === "dashboard" ? "DASHBOARD" : view === "heatmap" ? "MARKET MAP" : "ECONOMIC CALENDAR");

    const isDashboard = view === "dashboard";
    const overview = document.querySelector(".overview-panel");
    if (overview) overview.style.display = isDashboard ? "flex" : "none";

    const preactRoot = document.getElementById("preact-root");
    if (preactRoot) preactRoot.style.display = isDashboard ? "block" : "none";

    setDisplay("heatmap-section", view === "heatmap" ? "block" : "none");
    setDisplay("calendar-section", view === "calendar" ? "block" : "none");

    // ticker tape handled separately
    const tapeView = document.getElementById("ticker-tape-view");
    if (tapeView) tapeView.style.display = isDashboard ? "block" : "none";
  }, [view]);

  // Update overview panel + timestamp
  useEffect(() => {
    setText("total-positions", stats.positions ? String(stats.positions) : "--");
    setText("total-notional", stats.totalVal > 0 ? fmt.currency(stats.totalVal) : "--");

    if (stats.totalVal > 0) {
      const { percent, absolute } = stats.change;
      const sign = absolute >= 0 ? "+" : "";
      const absFormatted = sign + fmt.currency(Math.abs(absolute));
      const pctFormatted = fmt.percent(percent);
      setText("portfolio-change", `${absFormatted} (${pctFormatted})`);

      const trend = document.getElementById("portfolio-change");
      if (trend) {
        trend.className = `stat-trend ${percent > 0 ? "positive" : percent < 0 ? "negative" : "neutral"}`;
      }
    } else {
      setText("portfolio-change", "--");
    }

    // last updated
    const time = generatedAt ? new Date(generatedAt) : new Date();
    const dateStr = time.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
    const timeStr = time.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const modeText = isUsingDemoData ? " [DEMO]" : "";
    setText("last-update", `LAST UPDATED: ${dateStr} ${timeStr}${modeText}`);
  }, [generatedAt, isUsingDemoData, stats]);

  // Update ticker tape
  useEffect(() => {
    updateTickerTape(topTickers);
  }, [topTickers]);

  // Loading overlay (only for foreground loads)
  useEffect(() => {
    const overlay = document.getElementById("loading-overlay");
    if (!overlay) return;

    // In this first cut, we only show overlay for explicit sync button usage.
    // The hook still performs background refresh after add/remove.
    // Only show overlay for foreground sync
    overlay.style.display = isLoading && !isBackgroundLoading ? "flex" : "none";
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

  const onRemove = async (ticker) => {
    const res = await actions.remove({ ticker });
    if (res.ok) showToast("UPDATED");
    if (res.reason === "demo") showToast("Demo Mode: Changes not saved.");
  };

  const onSubmit = async ({ ticker, quantity, existingQuantity }) => {
    const res = await actions.addOrUpdate({ ticker, quantity, existingQuantity });
    if (res.ok) showToast("UPDATED");
    if (res.reason === "demo") showToast("Demo Mode: Changes not saved.");
  };

  // Keep sort defaults when switching tabs
  useEffect(() => {
    setSortCol(DEFAULT_SORT_COLS[tab]);
    setSortDir("desc");
  }, [tab]);

  return html`
    <div class="tabs-container" id="dashboard-tables">
      <div class="tabs-header">
        <div class="tab-group">
          <button class=${`tab-btn ${tab === "holdings" ? "active" : ""}`} onClick=${() => setTab("holdings")}>
            PORTFOLIO
          </button>
          <button class=${`tab-btn ${tab === "evaluations" ? "active" : ""}`} onClick=${() => setTab("evaluations")}>
            EVALUATION
          </button>
        </div>

        <${QuickAdd} rows=${rows} isUsingDemoData=${isUsingDemoData} onSubmit=${onSubmit} />
      </div>

      <${DataTable}
        tab=${tab}
        rows=${rows}
        sortCol=${sortCol}
        sortDir=${sortDir}
        onSort=${onSort}
        onRemove=${onRemove}
        animateRows=${!isBackgroundLoading}
      />
    </div>
  `;
}
