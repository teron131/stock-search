export const ROOT = "/";
export const DASHBOARD = "/dashboard";
export const SECTORS = "/sectors";
export const MARKETMAP = "/marketmap";
export const CALENDAR = "/calendar";
export const NEWS = "/news";

export const APP_PAGE_PATHS = [
	ROOT,
	DASHBOARD,
	NEWS,
	SECTORS,
	MARKETMAP,
	CALENDAR,
] as const;

export const AUTH_LOGIN = "/auth/login";
export const AUTH_CALLBACK = "/auth/callback";
export const AUTH_LOGOUT = "/auth/logout";
export const AUTH_SESSION = "/auth/session";

export const PORTFOLIO = "/portfolio";
export const PORTFOLIO_STATS = "/portfolio/stats";
export const PORTFOLIO_CORRELATION = "/portfolio/correlation";
export const PORTFOLIO_IMPORT_IMAGE = "/portfolio/import-image";
export const PORTFOLIO_NEWS = "/portfolio/news";
export const PORTFOLIO_NEWS_SUMMARY = "/portfolio/news/summary";
export const PORTFOLIO_NEWS_SUMMARIZE = "/portfolio/news/summarize";

/** Backend-only Hono route patterns. Use the path helpers below for concrete URLs. */
export const PORTFOLIO_TICKER_ROUTE = "/portfolio/:ticker";
export const STOCK_STATS_ROUTE = "/stock/:ticker/stats";
export const STOCK_EVALUATE_ROUTE = "/stock/:ticker/evaluate";
export const STOCK_NEWS_ROUTE = "/stock/:ticker/news";

export const STOCKS = "/stocks";
export const EVAL = "/eval";
export const COLOR_STANDARDS = "/color-standards";
export const REALTIME_CONFIG = "/realtime-config";

export const PUBLIC_STATIC_PREFIXES = ["/assets/", "/demo/", "/.well-known/"];

function encodePathSegment(value: string): string {
	return encodeURIComponent(String(value || "").trim());
}

export function portfolioTickerPath(ticker: string): string {
	return `/portfolio/${encodePathSegment(ticker)}`;
}

export function stockStatsPath(ticker: string): string {
	return `/stock/${encodePathSegment(ticker)}/stats`;
}

export function stockEvaluatePath(ticker: string): string {
	return `/stock/${encodePathSegment(ticker)}/evaluate`;
}

export function stockNewsPath(ticker: string): string {
	return `/stock/${encodePathSegment(ticker)}/news`;
}
