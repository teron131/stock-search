"use client";

import Image from "next/image";
import { useEffect } from "react";

import { App } from "../app-ui/App.js";
import { getIconDefinition, getNavIconName } from "../app-ui/sectors/icons.js";
import { APP_BASE_PATH, VIEW_ROUTES } from "../app-ui/shell/routes.js";
import { isTradingViewSymbolError } from "../app-ui/tradingViewSymbols.js";

const ACTION_ICON_PATHS = {
	logout: [
		<path key="door" d="M9 3.5H5.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1H9" />,
		<path key="arrow" d="M9.5 8h5" />,
		<path key="chev" d="M12.5 5.5 15 8l-2.5 2.5" />,
	],
	image: [
		<rect key="frame" x="3" y="3.5" width="10" height="9" rx="1.4" />,
		<path key="mountain" d="m4.5 10 2.6-2.7 2.1 2 1.2-1.1 2.1 2.3" />,
		<circle key="sun" cx="10.7" cy="5.8" r="0.9" />,
	],
	sync: [
		<path key="top" d="M12.8 5.3A4.8 4.8 0 0 0 4.2 6.9" />,
		<path key="topArrow" d="M12.8 3.2v2.1h-2.1" />,
		<path key="bottom" d="M3.2 10.7a4.8 4.8 0 0 0 8.6-1.6" />,
		<path key="bottomArrow" d="M3.2 12.8v-2.1h2.1" />,
	],
	stop: [<rect key="stop" x="4.5" y="4.5" width="7" height="7" rx="1" />],
};

const TOP_ACTIONS = [
	{ id: "logout-btn", label: "Logout", icon: "logout", hidden: true },
	{ id: "import-image-btn", label: "Import Image", icon: "image" },
	{ id: "refresh-btn", label: "Sync", icon: "sync" },
];

function NavIcon({ view }) {
	const iconDefinition = getIconDefinition(getNavIconName(view));
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.3"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{iconDefinition.paths.map((pathValue) => (
				<path key={pathValue} d={pathValue} />
			))}
		</svg>
	);
}

function ActionIcon({ name }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.35"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{ACTION_ICON_PATHS[name] || ACTION_ICON_PATHS.sync}
		</svg>
	);
}

function useSlideMenu() {
	useEffect(() => {
		const menuOpenBtn = document.getElementById("menu-open-btn");
		const menuCloseBtn = document.getElementById("menu-close-btn");
		const slideMenu = document.getElementById("slide-menu");
		const menuOverlay = document.getElementById("menu-overlay");
		if (!slideMenu || !menuOverlay) return;

		const openMenu = () => {
			slideMenu.classList.add("open");
			menuOverlay.classList.add("active");
		};
		const closeMenu = () => {
			slideMenu.classList.remove("open");
			menuOverlay.classList.remove("active");
		};

		menuOpenBtn?.addEventListener("click", openMenu);
		menuCloseBtn?.addEventListener("click", closeMenu);
		menuOverlay.addEventListener("click", closeMenu);
		document.querySelectorAll(".nav-item").forEach((item) => {
			item.addEventListener("click", closeMenu);
		});

		return () => {
			menuOpenBtn?.removeEventListener("click", openMenu);
			menuCloseBtn?.removeEventListener("click", closeMenu);
			menuOverlay.removeEventListener("click", closeMenu);
			document.querySelectorAll(".nav-item").forEach((item) => {
				item.removeEventListener("click", closeMenu);
			});
		};
	}, []);
}

function useTradingViewErrorGuard() {
	useEffect(() => {
		const onUnhandledRejection = (event) => {
			if (!isTradingViewSymbolError(event.reason)) return;
			event.preventDefault();
		};
		const onError = (event) => {
			if (!isTradingViewSymbolError(event.error || event.message)) return;
			event.preventDefault();
		};

		window.addEventListener("unhandledrejection", onUnhandledRejection);
		window.addEventListener("error", onError);
		return () => {
			window.removeEventListener("unhandledrejection", onUnhandledRejection);
			window.removeEventListener("error", onError);
		};
	}, []);
}

export function ClientApp({ initialView = "dashboard" }) {
	useSlideMenu();
	useTradingViewErrorGuard();

	return (
		<div className="terminal-layout">
			<div id="slide-menu" className="slide-menu">
				<div className="menu-header">
					<div className="brand">
						<Image
							className="brand-mark"
							src={`${APP_BASE_PATH}/logo.png`}
							alt=""
							width={840}
							height={840}
							priority
						/>
						<span className="brand-name">STOCK SEARCH</span>
					</div>
					<button
						type="button"
						className="close-btn"
						id="menu-close-btn"
						aria-label="Close menu"
					>
						&times;
					</button>
				</div>
				<nav className="main-nav">
					{VIEW_ROUTES.map((item) => (
						<a
							key={item.view}
							className={`nav-item ${item.view === initialView ? "active" : ""}`}
							data-view={item.view}
							href={item.path}
						>
							<NavIcon view={item.view} />
							<span>{item.label}</span>
						</a>
					))}
				</nav>
			</div>
			<div id="menu-overlay" className="menu-overlay" />

			<main className="main-content">
				<header className="top-bar">
					<div className="top-bar-left">
						<button
							type="button"
							id="menu-open-btn"
							className="hamburger-btn"
							aria-label="Open menu"
						>
							<svg
								aria-hidden="true"
								focusable="false"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								width="18"
								height="18"
							>
								<line x1="3" y1="12" x2="21" y2="12" />
								<line x1="3" y1="6" x2="21" y2="6" />
								<line x1="3" y1="18" x2="21" y2="18" />
							</svg>
						</button>
						<span className="view-title" id="view-title">
							DASHBOARD
						</span>
					</div>

					<div className="top-bar-right">
						<span className="last-update" id="last-update">
							--
						</span>
						<span className="sync-status" id="sync-status" />
						<span className="import-status" id="import-status" />
						<input
							id="import-image-input"
							type="file"
							accept="image/*"
							hidden
							aria-hidden="true"
							tabIndex="-1"
						/>
						<div className="action-icon-group">
							{TOP_ACTIONS.map(({ id, label, icon, hidden }) => (
								<button
									key={id}
									type="button"
									className="btn btn-secondary btn-icon-top"
									id={id}
									aria-label={label}
									data-tooltip={label}
									hidden={hidden}
								>
									<ActionIcon name={icon} />
								</button>
							))}
						</div>
					</div>
				</header>

				<div className="ticker-tape-container" id="ticker-tape-view">
					<div className="tradingview-widget-container" id="ticker-tape-widget">
						<div className="tradingview-widget-container__widget" />
					</div>
				</div>

				<div id="app-root" className="terminal-grid">
					<App initialView={initialView} />
				</div>

				<div id="secondary-views">
					<div
						id="heatmap-section"
						className="heatmap-container"
						style={{ display: "none" }}
					>
						<div className="tabs-header">
							<div className="tab-group">
								<button
									type="button"
									className="tab-btn active"
									data-source="SPX500"
								>
									S&amp;P_500
								</button>
								<button
									type="button"
									className="tab-btn"
									data-source="NASDAQ100"
								>
									NASDAQ_100
								</button>
							</div>
						</div>
						<div
							className="tradingview-widget-container"
							id="heatmap-widget-container"
						>
							<div className="tradingview-widget-container__widget" />
						</div>
					</div>

					<div
						id="calendar-section"
						className="calendar-container"
						style={{ display: "none" }}
					>
						<div
							className="tradingview-widget-container"
							id="calendar-widget-container"
						>
							<div className="tradingview-widget-container__widget" />
						</div>
					</div>
				</div>
			</main>
		</div>
	);
}
