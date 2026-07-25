const isBrowser = typeof window !== "undefined";
const demoParams = isBrowser ? new URLSearchParams(window.location.search) : null;
const isDemoMode =
  isBrowser &&
  (window.location.hostname.includes("github.io") ||
    demoParams?.get("demo") === "true" ||
    demoParams?.get("") === "demo");
const apiBase =
  isBrowser && window.location.hostname === "localhost" && window.location.port === "5173"
    ? "/api-proxy"
    : "";
const appBasePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

function normalizeBasePath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function apiPath(path) {
  return `${apiBase}${path}`;
}

function getDemoAssetUrl(filename) {
  return `${appBasePath}/demo/${filename}`;
}

import {
  MoatBlendConfig,
  OverallScoreWeights,
  QualitySignalConfig,
  TacticalScoreMultipliers,
  UpsideMultipliers,
  WarrantedFpeConfig,
} from "../../src/stock-search/evaluation/constants.ts";
import { getFieldMetadata } from "../../src/stock-search/models/field-definitions.ts";

export const CONFIG = {
  isDemoMode,

  endpoints: {
    authLogin: apiPath("/auth/login"),
    authLogout: apiPath("/auth/logout"),
    authSession: apiPath("/auth/session"),
    portfolio: apiPath("/portfolio"),
    portfolioCorrelation: apiPath("/portfolio/correlation"),
    portfolioImportImage: apiPath("/portfolio/import-image"),
    portfolioNews: apiPath("/portfolio/news"),
    portfolioNewsSummarize: apiPath("/portfolio/news/summarize"),
    sectors: apiPath("/sectors"),
    stock: apiPath("/stock"),
    stockStats: (ticker) =>
      apiPath(`/stock/${encodeURIComponent(String(ticker || "").trim())}/stats`),
    stockEvaluate: (ticker) =>
      apiPath(`/stock/${encodeURIComponent(String(ticker || "").trim())}/evaluate`),
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
    correlation: 45_000,
  },

  newsConcurrency: 4,
  newsFetchedRetentionMs: 3 * 24 * 60 * 60 * 1000,
  newsPublishedRetentionMs: 3 * 24 * 60 * 60 * 1000,
  stockNewsCacheTtlMs: 4 * 60 * 60 * 1000,
  newsAutoRefreshIntervalMs: 4 * 60 * 60 * 1000,
  portfolioNewsCacheTtlMs: 24 * 60 * 60 * 1000,

  portfolioScopes: {
    initial: "portfolio_cached",
    live: "portfolio_live",
  },

  defaultStrategy: null,
  maxTickerLength: 10,
  maxTickerTapeCount: 20,
  tableDisplayDefaults: {
    showNotional: true,
  },

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
  holdingQuantity: "holding-quantity",
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
  [WIDTH_GROUPS.holdingQuantity]: {
    paddingChars: 0,
    extraPx: 2,
    minPx: 74,
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

function formatWeightShare(value, total) {
  const percent = total > 0 ? (value / total) * 100 : 0;
  const rounded = Number(percent.toFixed(1));
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function weightedTooltipRows(entries) {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  return entries.map(([label, weight]) => ({
    label,
    value: formatWeightShare(weight, total),
  }));
}

const SCORE_TOOLTIP_ROWS = {
  overall_score: weightedTooltipRows([
    ["Moat", OverallScoreWeights.MOAT],
    ["Quality", OverallScoreWeights.QUALITY],
    ["Valuation", OverallScoreWeights.VALUATION],
    ["Upside", OverallScoreWeights.UPSIDE],
  ]),
  valuation_score: weightedTooltipRows([
    ["Legacy factors", WarrantedFpeConfig.LEGACY_WEIGHT],
    ["Warranted FPE", WarrantedFpeConfig.WARRANTED_FPE_WEIGHT],
  ]),
  moat_score: weightedTooltipRows([
    ["Economic proof", MoatBlendConfig.ECONOMIC_WEIGHT],
    ["Structural persistence", MoatBlendConfig.STRUCTURAL_WEIGHT],
  ]),
  quality_score: weightedTooltipRows([
    ["Current stats", QualitySignalConfig.CURRENT_WEIGHT],
    ["Margin persistence", QualitySignalConfig.MARGIN_PERSISTENCE_WEIGHT],
    ["FCF margin", QualitySignalConfig.FCF_MARGIN_WEIGHT],
    ["Share discipline", QualitySignalConfig.SHARES_DISCIPLINE_WEIGHT],
    ["Stability", QualitySignalConfig.STABILITY_WEIGHT],
  ]),
  upside_score: weightedTooltipRows([
    ["Revenue growth", UpsideMultipliers.REVENUE_GROWTH],
    ["EPS growth", UpsideMultipliers.EPS_GROWTH],
    ["Analyst upside", UpsideMultipliers.MEDIAN_UPSIDE],
    ["Rating", UpsideMultipliers.RATING],
  ]),
  tactical_score: weightedTooltipRows([
    ["1Y momentum", TacticalScoreMultipliers.PRICE_MOMENTUM_1Y],
    ["6M momentum", TacticalScoreMultipliers.PRICE_MOMENTUM_6M],
    ["Revenue growth", TacticalScoreMultipliers.REVENUE_GROWTH],
    ["EPS growth", TacticalScoreMultipliers.EPS_GROWTH],
    ["Valuation", TacticalScoreMultipliers.VALUATION],
    ["Analyst upside", TacticalScoreMultipliers.MEDIAN_UPSIDE],
    ["RSI activity", TacticalScoreMultipliers.RSI_ACTIVITY],
    ["IV activity", TacticalScoreMultipliers.IV_ACTIVITY],
  ]),
};

const FIELD_TOOLTIP_ROWS = {
  rd_knowledge_capital: [
    { label: "Latest FY R&D", value: "1.00x" },
    { label: "Prior FY R&D", value: "0.75x" },
    { label: "2Y ago R&D", value: "0.50x" },
    { label: "3Y ago R&D", value: "0.25x" },
  ],
};

function createEvaluationScoreColumn(key, label) {
  return createGroupedColumn(key, label, "score", WIDTH_GROUPS.evaluationScore, {
    tooltipRows: SCORE_TOOLTIP_ROWS[key],
  });
}

const BASE_COLUMNS = [
  createColumn("ticker", "TICKER"),
  createColumn("price", "PRICE", "currency"),
  createGroupedColumn("change_percent_1d", "CHG%", "percent", WIDTH_GROUPS.changePercent),
  createGroupedColumn("market_cap", "MKTC", "market_cap", WIDTH_GROUPS.abbrevCurrency),
  createGroupedColumn("pe", "PE", "number", WIDTH_GROUPS.marketNumber),
  createGroupedColumn("pe_forward", "FPE", "number", WIDTH_GROUPS.marketNumber),
  createGroupedColumn("ps", "PS", "number", WIDTH_GROUPS.marketNumber),
  createGroupedColumn("ps_forward", "FPS", "number", WIDTH_GROUPS.marketNumber),
  createGroupedColumn("peg", "PEG", "number", WIDTH_GROUPS.marketNumber),
  createGroupedColumn("beta", "BETA", "number", WIDTH_GROUPS.marketNumber),
  createGroupedColumn("iv", "IV", "percent_neutral", WIDTH_GROUPS.marketNumber),
  createGroupedColumn("rsi", "RSI", "number", WIDTH_GROUPS.marketNumber),
];

const MOMENTUM_COLUMNS = [
  createGroupedColumn("change_percent_1m", "1M%", "percent", WIDTH_GROUPS.changePercent),
  createGroupedColumn("change_percent_3m", "3M%", "percent", WIDTH_GROUPS.changePercent),
  createGroupedColumn("change_percent_6m", "6M%", "percent", WIDTH_GROUPS.changePercent),
  createGroupedColumn("change_percent_1y", "1Y%", "percent", WIDTH_GROUPS.changePercent),
  createGroupedColumn("median_upside", "UP%", "percent", WIDTH_GROUPS.changePercent),
];

const FUNDAMENTAL_COLUMN_SPECS = [
  ["revenue", "market_cap", WIDTH_GROUPS.abbrevCurrency],
  ["revenue_growth", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["revenue_growth_1y", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["revenue_cagr_3y", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["eps_growth", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["fcf_growth_1y", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["fcf_cagr_3y", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["gross_margin", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["gross_margin_median_3y", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["operating_margin", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["operating_margin_median_3y", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["roe", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["roic", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["debt_to_equity", "ratio_percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["free_cash_flow", "market_cap", WIDTH_GROUPS.abbrevCurrency],
  ["fcf_margin_median_3y", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["shares_change_1y", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["shares_change_cagr_3y", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["shareholder_yield", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["research_and_development", "market_cap", WIDTH_GROUPS.abbrevCurrency],
  ["rd_intensity", "percent_neutral", WIDTH_GROUPS.fundamentalPercent],
  ["rd_knowledge_capital", "market_cap", WIDTH_GROUPS.abbrevCurrency],
];
const SIGNED_GROWTH_COLUMNS = new Set([
  "revenue_growth",
  "revenue_growth_1y",
  "revenue_cagr_3y",
  "eps_growth",
  "fcf_growth_1y",
  "fcf_cagr_3y",
]);

function createFundamentalColumns({ signedGrowth = false } = {}) {
  return FUNDAMENTAL_COLUMN_SPECS.map(([key, format, widthGroup]) => {
    const displayFormat = signedGrowth && SIGNED_GROWTH_COLUMNS.has(key) ? "percent" : format;
    return createGroupedColumn(key, undefined, displayFormat, widthGroup, {
      tooltipRows: FIELD_TOOLTIP_ROWS[key],
    });
  });
}

const FUNDAMENTAL_COLUMNS_ALL = createFundamentalColumns();
const FUNDAMENTAL_COLUMNS_HOLDINGS = createFundamentalColumns({
  signedGrowth: true,
});

const EVALUATION_COLUMNS = [
  createColumn("rank", "RANK"),
  createEvaluationScoreColumn("overall_score", "SCORE"),
  createEvaluationScoreColumn("quality_score", "QUAL"),
  createEvaluationScoreColumn("valuation_score", "VAL"),
  createEvaluationScoreColumn("moat_score", "MOAT"),
  createEvaluationScoreColumn("upside_score", "UP"),
  createGroupedColumn("market_cap_score", "SIZE", "score", WIDTH_GROUPS.evaluationScore),
  createEvaluationScoreColumn("tactical_score", "TACT"),
];

const HOLDING_ACTION_COLUMNS = [
  createGroupedColumn("strategy", "STRAT", undefined, WIDTH_GROUPS.holdingStrategy, {
    cluster: HOLDINGS_TAIL_CLUSTER,
  }),
  createGroupedColumn("total", "VALUE", "currency", WIDTH_GROUPS.holdingCurrency, {
    cluster: HOLDINGS_TAIL_CLUSTER,
  }),
  createGroupedColumn("notional_value", "NOTL", "currency", WIDTH_GROUPS.holdingCurrency, {
    cluster: HOLDINGS_TAIL_CLUSTER,
  }),
  createGroupedColumn("weight_pct", "WGT%", "percent_neutral", WIDTH_GROUPS.holdingPercent, {
    cluster: HOLDINGS_TAIL_CLUSTER,
  }),
  createGroupedColumn(
    "notional_weight_pct",
    "NOTL%",
    "percent_neutral",
    WIDTH_GROUPS.holdingPercent,
    { cluster: HOLDINGS_TAIL_CLUSTER },
  ),
  createGroupedColumn("quantity", "QTY", "number", WIDTH_GROUPS.holdingQuantity, {
    cluster: HOLDINGS_TAIL_CLUSTER,
  }),
  createColumn("remove", "", "action", { cluster: HOLDINGS_TAIL_CLUSTER }),
];

export const NOTIONAL_COLUMN_KEYS = ["notional_value", "notional_weight_pct"];

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
    createGroupedColumn("strategy", "STRAT", undefined, WIDTH_GROUPS.holdingStrategy, {
      cluster: HOLDINGS_TAIL_CLUSTER,
    }),
    createColumn("remove", "", "action", { cluster: HOLDINGS_TAIL_CLUSTER }),
  ],
};

export const DEFAULT_SORT_COLS = {
  all: "notional_weight_pct",
  holdings: "notional_weight_pct",
  evaluations: "overall_score",
};
