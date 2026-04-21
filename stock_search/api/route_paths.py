"""Centralize API route path constants."""

from __future__ import annotations

ROOT = "/"
DASHBOARD = "/dashboard"
INDUSTRY = "/industry"
MARKETMAP = "/marketmap"
CALENDAR = "/calendar"

DASHBOARD_PAGE_PATHS = (
    ROOT,
    DASHBOARD,
    INDUSTRY,
    MARKETMAP,
    CALENDAR,
)

AUTH_LOGIN = "/auth/login"
AUTH_CALLBACK = "/auth/callback"
AUTH_LOGOUT = "/auth/logout"
AUTH_SESSION = "/auth/session"

PORTFOLIO = "/portfolio"
PORTFOLIO_TICKER = "/portfolio/{ticker}"
PORTFOLIO_IMPORT_IMAGE = "/portfolio/import-image"
PORTFOLIO_NEWS_SUMMARY = "/portfolio/news-summary"

STOCK_STATS = "/stock/{ticker}/stats"
STOCK_EVALUATE = "/stock/{ticker}/evaluate"
STOCK_NEWS = "/stock/{ticker}/news"

STOCKS = "/stocks"
EVAL = "/eval"
INDUSTRIES = "/industries"
COLOR_STANDARDS = "/color-standards"
REALTIME_CONFIG = "/realtime-config"
