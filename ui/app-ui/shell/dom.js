import { CONFIG } from "../config.js";

export const DASHBOARD_VIEW = "dashboard";
export const NEWS_VIEW = "news";
export const SECTORS_VIEW = "sectors";
export const MARKETMAP_VIEW = "marketmap";
export const CALENDAR_VIEW = "calendar";

const VIEW_TITLES = {
	[DASHBOARD_VIEW]: "DASHBOARD",
	[NEWS_VIEW]: "NEWS",
	[SECTORS_VIEW]: "SECTORS",
	[MARKETMAP_VIEW]: "MARKET MAP",
	[CALENDAR_VIEW]: "ECONOMIC CALENDAR",
};

export function setText(id, value) {
	const el = document.getElementById(id);
	if (el) el.textContent = value;
}

function setDisplay(id, display) {
	const el = document.getElementById(id);
	if (el) el.style.display = display;
}

export function formatLastUpdatedText(
	timestamp,
	{ isUsingDemoData = false } = {},
) {
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

export function showToast(message) {
	const toast = document.createElement("div");
	toast.className = "toast";
	toast.textContent = message;
	document.body.appendChild(toast);

	setTimeout(() => {
		toast.classList.add("toast-fade");
		setTimeout(() => toast.remove(), 500);
	}, 3000);
}

export function showActionError(reason, detail = null) {
	if (reason === "demo") showToast("Demo Mode: Changes not saved.");
	if (reason === "invalid") showToast("INVALID_QTY");
	if (reason === "server") showToast(detail || "UPDATE FAILED");
}

export function buildAuthLoginUrl() {
	const nextPath = `${window.location.pathname}${window.location.search}`;
	return `${CONFIG.endpoints.authLogin}?next=${encodeURIComponent(nextPath)}`;
}

export async function fetchAuthSession() {
	try {
		const response = await fetch(CONFIG.endpoints.authSession);
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

export function syncLogoutButton(authSession) {
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

export async function importImageFile(file, importImageRef) {
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

export function syncViewLayout(view) {
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

export function syncRefreshButtonState({
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

export function initSidebarAndNav() {
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
