export const CONFIG = {
    isDemoMode:
        window.location.hostname.includes("github.io") ||
        new URLSearchParams(window.location.search).get("demo") === "true",

    endpoints: {
        portfolio: "/portfolio",
        portfolioImportImage: "/portfolio/import-image",
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

    requestTimeoutMs: {
        portfolioForeground: 30_000,
        portfolioBackground: 120_000,
    },

    demoPaths: {
        primary: "sample_data",
        fallback: "data",
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

const BASE_COLUMNS = [
    { key: "ticker", label: "TICKER" },
    { key: "price", label: "PRICE", format: "currency" },
    { key: "change_percent", label: "CHANGE%", format: "percent" },
    { key: "market_cap", label: "MKT_CAP", format: "market_cap" },
    { key: "pe", label: "PE", format: "number" },
    { key: "pe_forward", label: "FWD_PE", format: "number" },
    { key: "peg", label: "PEG", format: "number" },
    { key: "beta", label: "BETA", format: "number" },
    { key: "iv", label: "IV", format: "percent_neutral" },
    { key: "rsi", label: "RSI", format: "number" },
];

const MOMENTUM_COLUMNS = [
    { key: "one_month_change_percent", label: "1M%", format: "percent" },
    { key: "three_month_change_percent", label: "3M%", format: "percent" },
    { key: "six_month_change_percent", label: "6M%", format: "percent" },
    { key: "one_year_change_percent", label: "1Y%", format: "percent" },
    { key: "median_upside", label: "UPSIDE%", format: "percent" },
];

const FUNDAMENTAL_COLUMNS_ALL = [
    { key: "revenue_growth", label: "GROWTH", format: "percent_neutral" },
    { key: "gross_margin", label: "MARGIN", format: "percent_neutral" },
    { key: "debt_to_equity", label: "DEBT", format: "percent_neutral" },
    { key: "free_cash_flow", label: "FCF", format: "market_cap" },
];

const FUNDAMENTAL_COLUMNS_HOLDINGS = [
    { key: "revenue_growth", label: "GROWTH", format: "percent" },
    { key: "gross_margin", label: "MARGIN", format: "percent_neutral" },
    { key: "debt_to_equity", label: "DEBT", format: "percent_neutral" },
    { key: "free_cash_flow", label: "FCF", format: "market_cap" },
];

const EVALUATION_COLUMNS = [
    { key: "rank", label: "RANK" },
    { key: "overall_score", label: "SCORE", format: "score" },
    { key: "quality_score", label: "QUALITY", format: "score" },
    { key: "valuation_score", label: "VALUE", format: "score" },
    { key: "moat_score", label: "MOAT", format: "score" },
    { key: "upside_score", label: "UPSIDE", format: "score" },
    { key: "bull_probability", label: "BULL", format: "prob" },
    { key: "bear_probability", label: "BEAR", format: "prob" },
];

const HOLDING_ACTION_COLUMNS = [
    { key: "strategy", label: "STRATEGY" },
    { key: "total", label: "VALUE", format: "currency" },
    { key: "weight_pct", label: "WEIGHT", format: "percent_neutral" },
    { key: "quantity", label: "QTY", format: "number" },
    { key: "remove", label: "", format: "action" },
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
        { key: "ticker", label: "TICKER" },
        ...EVALUATION_COLUMNS,
        { key: "strategy", label: "STRATEGY" },
        { key: "remove", label: "", format: "action" },
    ],
};

export const DEFAULT_SORT_COLS = {
    all: "weight_pct",
    holdings: "weight_pct",
    evaluations: "overall_score",
};
