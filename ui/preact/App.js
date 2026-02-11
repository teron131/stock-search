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

      navItems.forEach((n) =>
        n.classList.toggle("active", n.dataset.view === viewName),
      );
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

function initHeatmapTabs() {
  const tabs = document.querySelectorAll("#heatmap-section .tab-btn");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const source = tab.dataset.source;
      if (!source) return;

      tabs.forEach((t) =>
        t.classList.toggle("active", t.dataset.source === source),
      );
      createHeatmapWidget(source);
    });
  });
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
  useEffect(() => {
    syncRef.current = actions.sync;
  }, [actions.sync]);

  // Initial boot
  useEffect(() => {
    initSidebarAndNav({ onViewChange: setView });
    initHeatmapTabs();
    actions.sync({ background: false, scope: "priority" });

    const refreshBtn = document.getElementById("refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () =>
        actions.sync({ background: false }),
      );
    }
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
    setText(
      "total-positions",
      stats.positions ? String(stats.positions) : "--",
    );
    setText(
      "total-notional",
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
        trend.className = `stat-trend ${percent > 0 ? "positive" : percent < 0 ? "negative" : "neutral"}`;
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

    // In this first cut, we only show overlay for explicit sync button usage.
    // The hook still performs background refresh after add/remove.
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

  const onRemove = async (ticker) => {
    const res = await actions.remove({ ticker });
    if (res.ok) showToast("UPDATED");
    showActionError(res.reason);
  };

  const onSetQuantity = async ({
    ticker,
    quantity,
    delta,
    bucket,
    silent = false,
  }) => {
    const res = await actions.setQuantity({
      ticker,
      quantity,
      delta,
      bucket,
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

  const onSubmit = async ({ ticker, quantity, existingQuantity }) => {
    const res = await actions.addOrUpdate({
      ticker,
      quantity,
      existingQuantity,
    });
    if (res.ok) showToast("UPDATED");
    showActionError(res.reason);
  };

  return html`
    <div class="tabs-container" id="dashboard-tables">
      <div class="tabs-header">
        <div class="tab-group">
          <button
            class=${`tab-btn ${tab === "all" ? "active" : ""}`}
            onClick=${() => setTab("all")}
          >
            ALL
          </button>
          <button
            class=${`tab-btn ${tab === "holdings" ? "active" : ""}`}
            onClick=${() => setTab("holdings")}
          >
            PORTFOLIO
          </button>
          <button
            class=${`tab-btn ${tab === "evaluations" ? "active" : ""}`}
            onClick=${() => setTab("evaluations")}
          >
            EVALUATION
          </button>
        </div>

        <${QuickAdd}
          rows=${rows}
          isUsingDemoData=${isUsingDemoData}
          onSubmit=${onSubmit}
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
