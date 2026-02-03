export const CONFIG = {
  isDemoMode:
    window.location.hostname.includes("github.io") ||
    new URLSearchParams(window.location.search).get("demo") === "true",

  endpoints: {
    portfolio: "/api/portfolio",
    eval: "/api/eval",
    position: "/api/portfolio/position",
  },

  demoPaths: {
    primary: "data",
    fallback: "sample_data",
  },

  defaultBucket: "Tactical Opportunities",
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

export const COLS = {
  all: [
    { key: "ticker", label: "TICKER" },
    { key: "quantity", label: "QTY", format: "number" },
    { key: "current_price", label: "PRICE", format: "currency" },
    { key: "change_percent", label: "CHANGE%", format: "percent" },
    { key: "market_cap", label: "MKT_CAP", format: "market_cap" },
    { key: "pe", label: "PE", format: "number" },
    { key: "pe_forward", label: "FWD_PE", format: "number" },
    { key: "peg", label: "PEG", format: "number" },
    { key: "gross_margin", label: "MARGIN", format: "percent_neutral" },
    { key: "median_upside", label: "UPSIDE%", format: "percent" },
    { key: "rsi", label: "RSI", format: "number" },
    { key: "twenty_day_change_percent", label: "20D%", format: "percent" },
    { key: "fifty_day_change_percent", label: "50D%", format: "percent" },
    {
      key: "one_hundred_day_change_percent",
      label: "100D%",
      format: "percent",
    },
    {
      key: "two_hundred_day_change_percent",
      label: "200D%",
      format: "percent",
    },
    { key: "earning_direction", label: "EARN_DIR" },
    { key: "notional", label: "VALUE", format: "currency" },
    { key: "weight_pct", label: "WEIGHT", format: "percent_neutral" },
    { key: "bucket", label: "STRATEGY" },
    { key: "rank", label: "RANK" },
    { key: "overall", label: "SCORE", format: "score" },
    { key: "quality", label: "QUALITY", format: "score" },
    { key: "valuation", label: "VALUE", format: "score" },
    { key: "moat", label: "MOAT", format: "score" },
    { key: "upside", label: "UPSIDE", format: "score" },
    { key: "bull", label: "BULL", format: "prob" },
    { key: "bear", label: "BEAR", format: "prob" },
    { key: "remove", label: "", format: "action" },
  ],
  holdings: [
    { key: "ticker", label: "TICKER" },
    { key: "quantity", label: "QTY", format: "number" },
    { key: "current_price", label: "PRICE", format: "currency" },
    { key: "change_percent", label: "CHANGE%", format: "percent" },
    { key: "notional", label: "VALUE", format: "currency" },
    { key: "weight_pct", label: "WEIGHT", format: "percent_neutral" },
    { key: "bucket", label: "STRATEGY" },
    { key: "remove", label: "", format: "action" },
  ],
  evaluations: [
    { key: "ticker", label: "TICKER" },
    { key: "rank", label: "RANK" },
    { key: "overall", label: "SCORE", format: "score" },
    { key: "bull", label: "BULL", format: "prob" },
    { key: "bear", label: "BEAR", format: "prob" },
    { key: "bucket", label: "STRATEGY" },
    { key: "remove", label: "", format: "action" },
  ],
};

export const DEFAULT_SORT_COLS = {
  all: "weight_pct",
  holdings: "weight_pct",
  evaluations: "overall",
};
