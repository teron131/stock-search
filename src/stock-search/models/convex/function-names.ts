/** Define Convex function name constants. */

export const CONVEX_PORTFOLIO_GET = "portfolio:get";
export const CONVEX_PORTFOLIO_SET = "portfolio:set";
export const CONVEX_PORTFOLIO_GET_POSITIONS = "portfolio:getPositions";
export const CONVEX_PORTFOLIO_SET_POSITIONS = "portfolio:setPositions";
export const CONVEX_STOCK_LIST = "stock:list";
export const CONVEX_STOCK_LAST_UPDATED_AT = "stock:lastUpdatedAt";
export const CONVEX_STOCK_GET = "stock:get";
export const CONVEX_STOCK_GET_MANY = "stock:getMany";
export const CONVEX_STOCK_UPSERT = "stock:upsert";
export const CONVEX_STOCK_UPSERT_MANY = "stock:upsertMany";
export const CONVEX_STOCK_DELETE_BY_TICKERS = "stock:deleteByTickers";
export const CONVEX_STOCK_REPLACE_ALL = "stock:replaceAll";
export const CONVEX_NEWS_LIST = "news:list";
export const CONVEX_NEWS_DELETE_BY_TICKERS = "news:deleteByTickers";
export const CONVEX_NEWS_REPLACE_ALL = "news:replaceAll";
export const CONVEX_META_GET = "meta_versions:get";
export const CONVEX_META_SET = "meta_versions:set";

export type ConvexRealtimeTopic = {
	name: string;
	args?: Record<string, unknown>;
};

export const CONVEX_REALTIME_TOPICS = [
	{ name: CONVEX_PORTFOLIO_GET, args: { key: "default" } },
	{ name: CONVEX_STOCK_LAST_UPDATED_AT },
] as const;
