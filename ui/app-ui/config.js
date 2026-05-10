const isBrowser = typeof window !== "undefined";
const isDemoMode =
	isBrowser &&
	(window.location.hostname.includes("github.io") ||
		new URLSearchParams(window.location.search).get("demo") === "true");
const apiBase =
	isBrowser &&
	window.location.hostname === "localhost" &&
	window.location.port === "5173"
		? "/api-proxy"
		: "";

function apiPath(path) {
	return `${apiBase}${path}`;
}

function getDemoAssetUrl(filename) {
	if (!isBrowser) return `/demo/${filename}`;
	return new URL(`demo/${filename}`, window.location.href).toString();
}

import { getFieldMetadata } from "../../src/stock-search/models/field-definitions.ts";

export const CONFIG = {
	isDemoMode,

	endpoints: {
		authLogin: apiPath("/auth/login"),
		authLogout: apiPath("/auth/logout"),
		authSession: apiPath("/auth/session"),
		portfolio: apiPath("/portfolio"),
		portfolioImportImage: apiPath("/portfolio/import-image"),
		portfolioNewsSummary: apiPath("/portfolio/news-summary"),
		sectors: apiPath("/sectors"),
		stock: apiPath("/stock"),
		stockStats: (ticker) =>
			apiPath(
				`/stock/${encodeURIComponent(String(ticker || "").trim())}/stats`,
			),
		stockEvaluate: (ticker) =>
			apiPath(
				`/stock/${encodeURIComponent(String(ticker || "").trim())}/evaluate`,
			),
		stockNews: (ticker) =>
			apiPath(`/stock/${encodeURIComponent(String(ticker || "").trim())}/news`),
		colorStandards: apiPath("/color-standards"),
		realtimeConfig: apiPath("/realtime-config"),
	},

	demoEndpoints: {
		portfolio: getDemoAssetUrl("portfolio.json"),
		sectors: getDemoAssetUrl("sectors.json"),
		news: getDemoAssetUrl("news.json"),
		colorStandards: getDemoAssetUrl("color-standards.json"),
	},

	requestTimeoutMs: {
		portfolioForeground: 30_000,
		portfolioBackground: 120_000,
		sectors: 30_000,
		news: 30_000,
	},

	newsConcurrency: 4,
	newsFetchedRetentionMs: 3 * 24 * 60 * 60 * 1000,
	newsPublishedRetentionMs: 3 * 24 * 60 * 60 * 1000,
	stockNewsCacheTtlMs: 4 * 60 * 60 * 1000,
	newsAutoRefreshIntervalMs: 4 * 60 * 60 * 1000,
	portfolioNewsCacheTtlMs: 24 * 60 * 60 * 1000,

	portfolioScopes: {
		initial: "priority",
		live: "portfolio_live",
	},

	defaultStrategy: null,
	maxTickerLength: 10,
	maxTickerTapeCount: 20,

	animationDelayMs: 30,
	scoreThresholds: { high: 8, low: 4 },
	colorBandFraction: 0.5,

	heatmapWidget: {
		blockSize: "Value.Traded|1W",
		blockColor: "change",
		grouping: "sector",
		locale: "en",
		symbolUrl: "",
		colorTheme: "dark",
		exchanges: ["NYSE", "NASDAQ"],
		hasTopBar: true,
		isDataSetEnabled: false,
		isZoomEnabled: true,
		hasSymbolTooltip: true,
		isMonoSize: false,
		width: "100%",
		height: "100%",
	},
};

const WIDTH_GROUPS = {
	changePercent: "change-percent",
	abbrevCurrency: "abbrev-currency",
	marketNumber: "market-number",
	fundamentalPercent: "fundamental-percent",
	evaluationScore: "evaluation-score",
	holdingStrategy: "holding-strategy",
	holdingCurrency: "holding-currency",
	holdingPercent: "holding-percent",
};

const HOLDINGS_TAIL_CLUSTER = "holdings-tail";

export const WIDTH_GROUP_OPTIONS = {
	[WIDTH_GROUPS.changePercent]: {
		paddingChars: 0,
		extraPx: 2,
	},
	[WIDTH_GROUPS.abbrevCurrency]: {
		paddingChars: 0,
		extraPx: 2,
	},
	[WIDTH_GROUPS.marketNumber]: {
		paddingChars: 0,
		extraPx: 2,
	},
	[WIDTH_GROUPS.fundamentalPercent]: {
		paddingChars: 0,
		extraPx: 2,
	},
	[WIDTH_GROUPS.evaluationScore]: {
		paddingChars: 0,
		extraPx: 2,
	},
	[WIDTH_GROUPS.holdingStrategy]: {
		paddingChars: 0,
		extraPx: 2,
	},
	[WIDTH_GROUPS.holdingCurrency]: {
		paddingChars: 0,
		extraPx: 2,
	},
	[WIDTH_GROUPS.holdingPercent]: {
		paddingChars: 0,
		extraPx: 2,
	},
};

function createColumn(key, label, format, options = {}) {
	const fieldMetadata = getFieldMetadata(key);
	return {
		key,
		label: label || fieldMetadata.shortLabel,
		tooltip: fieldMetadata.label,
		description: fieldMetadata.description,
		...(format ? { format } : {}),
		...options,
	};
}

function createGroupedColumn(key, label, format, widthGroup, options = {}) {
	return createColumn(key, label, format, { ...options, widthGroup });
}

const BASE_COLUMNS = [
	createColumn("ticker", "TICKER"),
	createColumn("price", "PRICE", "currency"),
	createGroupedColumn(
		"change_percent_1d",
		"CHG%",
		"percent",
		WIDTH_GROUPS.changePercent,
	),
	createGroupedColumn(
		"market_cap",
		"MCAP",
		"market_cap",
		WIDTH_GROUPS.abbrevCurrency,
	),
	createGroupedColumn("pe", "PE", "number", WIDTH_GROUPS.marketNumber),
	createGroupedColumn("pe_forward", "FPE", "number", WIDTH_GROUPS.marketNumber),
	createGroupedColumn("peg", "PEG", "number", WIDTH_GROUPS.marketNumber),
	createGroupedColumn("beta", "BETA", "number", WIDTH_GROUPS.marketNumber),
	createGroupedColumn("iv", "IV", "percent_neutral", WIDTH_GROUPS.marketNumber),
	createGroupedColumn("rsi", "RSI", "number", WIDTH_GROUPS.marketNumber),
];

const MOMENTUM_COLUMNS = [
	createGroupedColumn(
		"change_percent_1m",
		"1M%",
		"percent",
		WIDTH_GROUPS.changePercent,
	),
	createGroupedColumn(
		"change_percent_3m",
		"3M%",
		"percent",
		WIDTH_GROUPS.changePercent,
	),
	createGroupedColumn(
		"change_percent_6m",
		"6M%",
		"percent",
		WIDTH_GROUPS.changePercent,
	),
	createGroupedColumn(
		"change_percent_1y",
		"1Y%",
		"percent",
		WIDTH_GROUPS.changePercent,
	),
	createGroupedColumn(
		"median_upside",
		"UP%",
		"percent",
		WIDTH_GROUPS.changePercent,
	),
];

const FUNDAMENTAL_COLUMNS_ALL = [
	createGroupedColumn(
		"revenue_growth",
		"REV%",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"gross_margin",
		"GM%",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"operating_margin",
		"OM%",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"roic",
		"ROIC",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"debt_to_equity",
		"D/E",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"free_cash_flow",
		"FCF",
		"market_cap",
		WIDTH_GROUPS.abbrevCurrency,
	),
	createGroupedColumn(
		"shareholder_yield",
		"YLD%",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
];

const FUNDAMENTAL_COLUMNS_HOLDINGS = [
	createGroupedColumn(
		"revenue_growth",
		"REV%",
		"percent",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"gross_margin",
		"GM%",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"operating_margin",
		"OM%",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"roic",
		"ROIC",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"debt_to_equity",
		"D/E",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"free_cash_flow",
		"FCF",
		"market_cap",
		WIDTH_GROUPS.abbrevCurrency,
	),
	createGroupedColumn(
		"shareholder_yield",
		"YLD%",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
];

const EVALUATION_COLUMNS = [
	createColumn("rank", "RANK"),
	createGroupedColumn(
		"overall_score",
		"SCORE",
		"score",
		WIDTH_GROUPS.evaluationScore,
	),
	createGroupedColumn(
		"quality_score",
		"QUAL",
		"score",
		WIDTH_GROUPS.evaluationScore,
	),
	createGroupedColumn(
		"valuation_score",
		"VAL",
		"score",
		WIDTH_GROUPS.evaluationScore,
	),
	createGroupedColumn(
		"moat_score",
		"MOAT",
		"score",
		WIDTH_GROUPS.evaluationScore,
	),
	createGroupedColumn(
		"upside_score",
		"UP",
		"score",
		WIDTH_GROUPS.evaluationScore,
	),
	createGroupedColumn(
		"market_cap_score",
		"SIZE",
		"score",
		WIDTH_GROUPS.evaluationScore,
	),
];

const HOLDING_ACTION_COLUMNS = [
	createGroupedColumn(
		"strategy",
		"STRAT",
		undefined,
		WIDTH_GROUPS.holdingStrategy,
		{ cluster: HOLDINGS_TAIL_CLUSTER },
	),
	createGroupedColumn(
		"total",
		"VALUE",
		"currency",
		WIDTH_GROUPS.holdingCurrency,
		{ cluster: HOLDINGS_TAIL_CLUSTER },
	),
	createGroupedColumn(
		"notional_value",
		"NOTL",
		"currency",
		WIDTH_GROUPS.holdingCurrency,
		{ cluster: HOLDINGS_TAIL_CLUSTER },
	),
	createGroupedColumn(
		"weight_pct",
		"WGT%",
		"percent_neutral",
		WIDTH_GROUPS.holdingPercent,
		{ cluster: HOLDINGS_TAIL_CLUSTER },
	),
	createGroupedColumn(
		"notional_weight_pct",
		"NOTL%",
		"percent_neutral",
		WIDTH_GROUPS.holdingPercent,
		{ cluster: HOLDINGS_TAIL_CLUSTER },
	),
	createColumn("quantity", "QTY", "number", { cluster: HOLDINGS_TAIL_CLUSTER }),
	createColumn("remove", "", "action", { cluster: HOLDINGS_TAIL_CLUSTER }),
];

export const COLS = {
	all: [
		...BASE_COLUMNS,
		...MOMENTUM_COLUMNS,
		...FUNDAMENTAL_COLUMNS_ALL,
		...EVALUATION_COLUMNS,
		...HOLDING_ACTION_COLUMNS,
	],
	holdings: [
		...BASE_COLUMNS,
		...MOMENTUM_COLUMNS,
		...FUNDAMENTAL_COLUMNS_HOLDINGS,
		...HOLDING_ACTION_COLUMNS,
	],
	evaluations: [
		createColumn("ticker", "TICKER"),
		...EVALUATION_COLUMNS,
		createGroupedColumn(
			"strategy",
			"STRAT",
			undefined,
			WIDTH_GROUPS.holdingStrategy,
			{ cluster: HOLDINGS_TAIL_CLUSTER },
		),
		createColumn("remove", "", "action", { cluster: HOLDINGS_TAIL_CLUSTER }),
	],
};

export const DEFAULT_SORT_COLS = {
	all: "notional_weight_pct",
	holdings: "notional_weight_pct",
	evaluations: "overall_score",
};
