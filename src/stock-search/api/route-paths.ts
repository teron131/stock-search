export const ROOT = "/";
export const DASHBOARD = "/dashboard";
export const INDUSTRY = "/industry";
export const MARKETMAP = "/marketmap";
export const CALENDAR = "/calendar";

export const DASHBOARD_PAGE_PATHS = [
	ROOT,
	DASHBOARD,
	INDUSTRY,
	MARKETMAP,
	CALENDAR,
] as const;

export const AUTH_LOGIN = "/auth/login";
export const AUTH_CALLBACK = "/auth/callback";
export const AUTH_LOGOUT = "/auth/logout";
export const AUTH_SESSION = "/auth/session";

export const PORTFOLIO = "/portfolio";
export const PORTFOLIO_TICKER = "/portfolio/:ticker";
export const PORTFOLIO_IMPORT_IMAGE = "/portfolio/import-image";
export const PORTFOLIO_NEWS_SUMMARY = "/portfolio/news-summary";

export const STOCK_STATS = "/stock/:ticker/stats";
export const STOCK_EVALUATE = "/stock/:ticker/evaluate";
export const STOCK_NEWS = "/stock/:ticker/news";

export const STOCKS = "/stocks";
export const EVAL = "/eval";
export const INDUSTRIES = "/industries";
export const COLOR_STANDARDS = "/color-standards";
export const REALTIME_CONFIG = "/realtime-config";

export const PUBLIC_STATIC_PREFIXES = ["/assets/", "/demo/", "/.well-known/"];
