"""Exa fallback prompts for StockAnalysis extraction."""

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
