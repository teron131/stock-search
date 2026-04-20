const isDemoMode =
	window.location.hostname.includes("github.io") ||
	new URLSearchParams(window.location.search).get("demo") === "true";

function getDemoAssetUrl(filename) {
	return new URL(`demo/${filename}`, window.location.href).toString();
}

export const CONFIG = {
	isDemoMode,

	endpoints: {
		portfolio: "/portfolio",
		portfolioImportImage: "/portfolio/import-image",
		portfolioNewsSummary: "/portfolio/news-summary",
		industries: "/industries",
		stock: "/stock",
		stockStats: (ticker) =>
			`/stock/${encodeURIComponent(String(ticker || "").trim())}/stats`,
		stockEvaluate: (ticker) =>
			`/stock/${encodeURIComponent(String(ticker || "").trim())}/evaluate`,
		stockNews: (ticker) =>
			`/stock/${encodeURIComponent(String(ticker || "").trim())}/news`,
		colorStandards: "/color-standards",
		realtimeConfig: "/realtime-config",
	},

	demoEndpoints: {
		portfolio: getDemoAssetUrl("portfolio.json"),
		industries: getDemoAssetUrl("industries.json"),
		news: getDemoAssetUrl("news.json"),
		colorStandards: getDemoAssetUrl("color-standards.json"),
	},

	requestTimeoutMs: {
		portfolioForeground: 30_000,
		portfolioBackground: 120_000,
		industries: 30_000,
		news: 30_000,
	},

	newsConcurrency: 4,
	stockNewsCacheTtlMs: 4 * 60 * 60 * 1000,
	newsAutoRefreshIntervalMs: 4 * 60 * 60 * 1000,
	portfolioNewsCacheTtlMs: 24 * 60 * 60 * 1000,

	portfolioScopes: {
		initial: "priority",
		live: "portfolio_live",
	},

	defaultStrategy: "Speculation",
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
	evaluationProbability: "evaluation-probability",
};

function createColumn(key, label, format) {
	return format ? { key, label, format } : { key, label };
}

function createGroupedColumn(key, label, format, widthGroup) {
	return { ...createColumn(key, label, format), widthGroup };
}

const BASE_COLUMNS = [
	createColumn("ticker", "TICKER"),
	createColumn("price", "PRICE", "currency"),
	createGroupedColumn(
		"change_percent_1d",
		"CHANGE%",
		"percent",
		WIDTH_GROUPS.changePercent,
	),
	createGroupedColumn(
		"market_cap",
		"MKT_CAP",
		"market_cap",
		WIDTH_GROUPS.abbrevCurrency,
	),
	createGroupedColumn("pe", "PE", "number", WIDTH_GROUPS.marketNumber),
	createGroupedColumn(
		"pe_forward",
		"FWD_PE",
		"number",
		WIDTH_GROUPS.marketNumber,
	),
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
		"UPSIDE%",
		"percent",
		WIDTH_GROUPS.changePercent,
	),
];

const FUNDAMENTAL_COLUMNS_ALL = [
	createGroupedColumn(
		"revenue_growth",
		"GROWTH",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"gross_margin",
		"GROSS",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"debt_to_equity",
		"DEBT",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"free_cash_flow",
		"FCF",
		"market_cap",
		WIDTH_GROUPS.abbrevCurrency,
	),
];

const FUNDAMENTAL_COLUMNS_HOLDINGS = [
	createGroupedColumn(
		"revenue_growth",
		"GROWTH",
		"percent",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"gross_margin",
		"GROSS",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"debt_to_equity",
		"DEBT",
		"percent_neutral",
		WIDTH_GROUPS.fundamentalPercent,
	),
	createGroupedColumn(
		"free_cash_flow",
		"FCF",
		"market_cap",
		WIDTH_GROUPS.abbrevCurrency,
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
		"QUALITY",
		"score",
		WIDTH_GROUPS.evaluationScore,
	),
	createGroupedColumn(
		"valuation_score",
		"VALUE",
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
		"UPSIDE",
		"score",
		WIDTH_GROUPS.evaluationScore,
	),
	createGroupedColumn(
		"bull_probability",
		"BULL",
		"prob",
		WIDTH_GROUPS.evaluationProbability,
	),
	createGroupedColumn(
		"bear_probability",
		"BEAR",
		"prob",
		WIDTH_GROUPS.evaluationProbability,
	),
];

const HOLDING_ACTION_COLUMNS = [
	createColumn("strategy", "STRATEGY"),
	createColumn("total", "VALUE", "currency"),
	createColumn("weight_pct", "WEIGHT", "percent_neutral"),
	createColumn("quantity", "QTY", "number"),
	createColumn("remove", "", "action"),
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
		createColumn("strategy", "STRATEGY"),
		createColumn("remove", "", "action"),
	],
};

export const DEFAULT_SORT_COLS = {
	all: "weight_pct",
	holdings: "weight_pct",
	evaluations: "overall_score",
};
