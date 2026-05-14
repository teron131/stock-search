import { CONFIG } from "../config.js";

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
const TRADING_VIEW_PLACEHOLDER_HTML =
	'<div class="tradingview-widget-container__widget"></div>';
const HEATMAP_SCRIPT_SRC =
	"https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js";
const CALENDAR_SCRIPT_SRC =
	"https://s3.tradingview.com/external-embedding/embed-widget-events.js";
const DEFAULT_HEATMAP_SOURCE = "SPX500";

let tickerTapeRetryId = null;

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

export function updateTickerTape(tickers) {
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

function createTradingViewScript(src, options) {
	const script = document.createElement("script");
	script.type = "text/javascript";
	script.src = src;
	script.async = true;
	script.innerHTML = JSON.stringify(options);
	return script;
}

export function createHeatmapWidget(dataSource) {
	const container = document.getElementById("heatmap-widget-container");
	if (!container) return;

	container.innerHTML = TRADING_VIEW_PLACEHOLDER_HTML;
	container.appendChild(
		createTradingViewScript(HEATMAP_SCRIPT_SRC, {
			...CONFIG.heatmapWidget,
			dataSource,
		}),
	);
}

export function createCalendarWidget() {
	const container = document.getElementById("calendar-widget-container");
	if (!container) return;

	container.innerHTML = TRADING_VIEW_PLACEHOLDER_HTML;
	container.appendChild(
		createTradingViewScript(CALENDAR_SCRIPT_SRC, {
			colorTheme: "dark",
			isTransparent: false,
			locale: "en",
			countryFilter: "us",
			importanceFilter: "-1,0,1",
			width: "100%",
			height: "100%",
		}),
	);
}

export function initHeatmapTabs() {
	const tabs = document.querySelectorAll("#heatmap-section .tab-btn");
	const cleanupFns = [];
	createHeatmapWidget(DEFAULT_HEATMAP_SOURCE);

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
