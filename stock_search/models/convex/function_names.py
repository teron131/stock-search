from __future__ import annotations

CONVEX_PORTFOLIO_GET = "portfolio:get"
CONVEX_PORTFOLIO_SET = "portfolio:set"
CONVEX_STOCK_LIST = "stock:list"
CONVEX_STOCK_GET = "stock:get"
CONVEX_STOCK_REPLACE_ALL = "stock:replaceAll"
CONVEX_NEWS_LIST = "news:list"
CONVEX_NEWS_REPLACE_ALL = "news:replaceAll"
CONVEX_META_GET = "meta_versions:get"
CONVEX_META_SET = "meta_versions:set"

CONVEX_REALTIME_TOPICS: tuple[str, ...] = (
    CONVEX_PORTFOLIO_GET,
    CONVEX_STOCK_LIST,
)
