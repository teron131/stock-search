"""Constants and page specs for StockAnalysis extraction."""

from __future__ import annotations

import re

STOCKANALYSIS_STATISTICS_URL = "https://stockanalysis.com/stocks/{ticker}/statistics/"
STOCKANALYSIS_FINANCIALS_URL = "https://stockanalysis.com/stocks/{ticker}/financials/"
STOCKANALYSIS_ETF_HOLDINGS_URL = "https://stockanalysis.com/etf/{ticker}/holdings/"

ETF_DATA_SCRIPT_FRAGMENTS = ("holdings:[", "sectors:[")
HOLDINGS_BLOCK_PATTERN = re.compile(r"holdings:\[(.*?)\],asset_allocation:", re.DOTALL)
HOLDING_ROW_PATTERN = re.compile(
    r'\{[^{}]*n:"([^"]+)"[^{}]*s:"([^"]+)"[^{}]*as:"([\d.]+)%"',
    re.DOTALL,
)
SECTORS_BLOCK_PATTERN = re.compile(
    r"sectors:\[(.*?)\],(?:countries|allocationChartData):",
    re.DOTALL,
)
SECTOR_ROW_PATTERN = re.compile(r'\{n:"([^"]+)",w:([\d.]+)\}')
QUOTE_BLOCK_PATTERN = re.compile(r"quote:\{(.*?)\},stream:", re.DOTALL)

COMPACT_NUMBER_SUFFIXES = {
    "K": 1_000.0,
    "M": 1_000_000.0,
    "B": 1_000_000_000.0,
    "T": 1_000_000_000_000.0,
}
NULLISH_TEXT = {"", "-", "n/a", "N/A", "na", "NA"}
QUOTE_EMPTY_FIELDS = {"price": None, "change": None, "change_percent": None}
REGULAR_QUOTE_KEYS = {"price": "p", "change": "c", "change_percent": "cp"}
EXTENDED_QUOTE_KEYS = {"price": "ep", "change": "ec", "change_percent": "ecp"}
EXTENDED_SESSION_NAMES = {"Pre-market", "After-hours"}

SECTOR_FIELD_BY_LABEL = {
    "Communication Services": "communication_services",
    "Consumer Discretionary": "consumer_discretionary",
    "Consumer Staples": "consumer_staples",
    "Energy": "energy",
    "Financials": "financials",
    "Health Care": "health_care",
    "Industrials": "industrials",
    "Materials": "materials",
    "Real Estate": "real_estate",
    "Technology": "technology",
    "Utilities": "utilities",
    "Other": "other",
}

STATISTICS_FIELD_SPECS = {
    "market_cap": ("Market Cap", "_parse_number"),
    "beta": ("Beta (5Y)", "_parse_number"),
    "fifty_two_week_price_change": ("52-Week Price Change", "_parse_percent_points"),
    "moving_average_50d": ("50-Day Moving Average", "_parse_number"),
    "moving_average_200d": ("200-Day Moving Average", "_parse_number"),
    "rsi": ("Relative Strength Index (RSI)", "_parse_number"),
    "average_volume_20d": ("Average Volume (20 Days)", "_parse_number"),
    "pe": ("PE Ratio", "_parse_number"),
    "pe_forward": ("Forward PE", "_parse_number"),
    "peg": ("PEG Ratio", "_parse_number"),
    "roic": ("Return on Invested Capital (ROIC)", "_parse_percent_ratio"),
    "gross_margin": ("Gross Margin", "_parse_percent_ratio"),
    "operating_margin": ("Operating Margin", "_parse_percent_ratio"),
    "debt_to_equity": ("Debt / Equity", "_parse_number"),
    "debt_to_ebitda": ("Debt / EBITDA", "_parse_number"),
    "free_cash_flow": ("Free Cash Flow", "_parse_number"),
}

FINANCIALS_FIELD_SPECS = {
    "revenue_growth": ("Revenue Growth (YoY)", "_parse_percent_ratio"),
    "eps_diluted": ("EPS (Diluted)", "_parse_number"),
    "eps_growth": ("EPS Growth", "_parse_percent_ratio"),
    "gross_margin": ("Gross Margin", "_parse_percent_ratio"),
    "operating_margin": ("Operating Margin", "_parse_percent_ratio"),
}

STATISTICS_SYSTEM_PROMPT = """Extract statistics for {ticker}.
Use this URL as the primary source:
{statistics_url}
Only fall back to other stockanalysis.com pages if this page lacks a field.

Normalization rules:
- market_cap: absolute dollars (not shorthand like B/M)
- pe, pe_forward, peg: numeric ratios
- roic, gross_margin, and operating_margin: ratios (e.g. 52.49% -> 0.5249)
- debt_to_ebitda: numeric ratio
- free_cash_flow: absolute dollars
- fifty_two_week_price_change: percentage points (e.g. 34.5 for 34.5%)
- moving_average_50d and moving_average_200d: absolute price values
- rsi: RSI numeric value (0-100)
- average_volume_20d: shares (absolute number)
"""

FINANCIALS_SYSTEM_PROMPT = """Extract financial metrics for {ticker}.
Use this URL as the primary source:
{financials_url}
Only fall back to other stockanalysis.com pages if this page lacks a field.

Column-selection rule (mandatory):
- Only extract from the first data column (the current/latest column).
- Ignore all older columns to the right (prior years/quarters).

Normalization rules:
- revenue_growth: ratio (e.g. 23.4% -> 0.234)
- eps_diluted: absolute EPS value
- eps_growth: ratio (e.g. 18.0% -> 0.18)
- gross_margin and operating_margin: ratios (e.g. 52.49% -> 0.5249)
"""

ETF_HOLDINGS_SEARCH_SYSTEM_PROMPT = """Find ETF holdings and weightings for {ticker}.

Rules:
- Prioritize stockanalysis.com domain.
- Return holdings only with fields:
  - ticker symbol
  - holding name
  - weight percentage
- Exclude US exchange prefixes.
- Keep non-US exchange prefixes when present.
- If unavailable, return an empty holdings list."""

ETF_SECTOR_SEARCH_SYSTEM_PROMPT = """Find ETF sector allocation percentages for {ticker}.

Rules:
- Prioritize stockanalysis.com and schwab.wallst.com domains.
- Ignore Yahoo pages and any other domains.
- Return sectors as normalized category names from the schema.
- Use numeric weights in 0-100 format.
- Prefer complete sector breakdowns whose weights sum to approximately 100.
- If the two allowed sources disagree, prefer StockAnalysis first, then Schwab.
- If data is unavailable, return an empty sectors list."""
