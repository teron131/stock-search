"use client";

import Image from "next/image";
import { useEffect } from "react";

import { App } from "../app-ui/App.js";
import { getIconDefinition, getNavIconName } from "../app-ui/sectorIcons.js";
import { isTradingViewSymbolError } from "../app-ui/tradingViewSymbols.js";
import { getPathForView } from "../app-ui/viewRoutes.js";

const NAV_ITEMS = [
	{ view: "dashboard", label: "DASHBOARD" },
	{ view: "news", label: "NEWS" },
	{ view: "sectors", label: "SECTORS" },
	{ view: "marketmap", label: "MARKET MAP" },
	{ view: "calendar", label: "ECONOMIC CALENDAR" },
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
							src="/logo.png"
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
					{NAV_ITEMS.map((item) => (
						<a
							key={item.view}
							className={`nav-item ${item.view === initialView ? "active" : ""}`}
							data-view={item.view}
							href={getPathForView(item.view)}
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
							<button
								type="button"
								className="btn btn-secondary btn-icon-top"
								id="logout-btn"
								title="Logout"
								hidden
							>
								OUT
							</button>
							<button
								type="button"
								className="btn btn-secondary btn-icon-top"
								id="import-image-btn"
								title="Import Image"
							>
								IMG
							</button>
							<button
								type="button"
								className="btn btn-secondary btn-icon-top"
								id="refresh-btn"
								title="Sync"
							>
								SYNC
							</button>
						</div>
					</div>
				</header>

				<div className="ticker-tape-container" id="ticker-tape-view">
					<tv-ticker-tape
						suppressHydrationWarning={true}
						id="ticker-tape-widget"
						symbols=""
						line-chart-type="Baseline"
						item-size="compact"
						show-hover=""
						transparent=""
						theme="dark"
					/>
				</div>

				<div id="stats-strip" className="stats-strip">
					<div className="stats-item">
						<span className="stats-label">TOT:</span>
						<span className="stats-value" id="total-value">
							--
						</span>
					</div>
					<div className="stats-item">
						<span className="stats-label">CHG:</span>
						<span className="stats-value stats-trend" id="portfolio-change">
							--
						</span>
					</div>
					<div className="stats-item">
						<span className="stats-label">POS:</span>
						<span className="stats-value" id="total-positions">
							--
						</span>
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
