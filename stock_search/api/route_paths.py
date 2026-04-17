"""Centralize API route path constants."""

from __future__ import annotations

PORTFOLIO = "/portfolio"
PORTFOLIO_TICKER = "/portfolio/{ticker}"
PORTFOLIO_IMPORT_IMAGE = "/portfolio/import-image"

STOCK_STATS = "/stock/{ticker}/stats"
STOCK_EVALUATE = "/stock/{ticker}/evaluate"
STOCK_NEWS = "/stock/{ticker}/news"

STOCKS = "/stocks"
EVAL = "/eval"
INDUSTRIES = "/industries"
COLOR_STANDARDS = "/color-standards"
REALTIME_CONFIG = "/realtime-config"
