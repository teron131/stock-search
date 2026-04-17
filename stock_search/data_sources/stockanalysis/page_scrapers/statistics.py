"""StockAnalysis statistics page scraping helpers."""

from __future__ import annotations

from collections.abc import Callable
import re

from selectolax.lexbor import LexborHTMLParser

from ..parsing import (
    build_model_from_rows,
    extract_quote_scalar,
    extract_table_rows,
    parse_number,
)
from ..schemas import StockAnalysisStatistics

STOCKANALYSIS_STATISTICS_URL = "https://stockanalysis.com/stocks/{ticker}/statistics/"

QUOTE_BLOCK_PATTERN = re.compile(r"quote:\{(.*?)\},stream:", re.DOTALL)
QUOTE_EMPTY_FIELDS = {"price": None, "change": None, "change_percent_1d": None}
REGULAR_QUOTE_KEYS = {"price": "p", "change": "c", "change_percent_1d": "cp"}
EXTENDED_QUOTE_KEYS = {"price": "ep", "change": "ec", "change_percent_1d": "ecp"}
EXTENDED_SESSION_NAMES = {"Pre-market", "After-hours"}

STATISTICS_FIELD_SPECS = {
    "market_cap": ("Market Cap", "parse_number"),
    "beta": ("Beta (5Y)", "parse_number"),
    "fifty_two_week_price_change": ("52-Week Price Change", "parse_percent_points"),
    "moving_average_50d": ("50-Day Moving Average", "parse_number"),
    "moving_average_200d": ("200-Day Moving Average", "parse_number"),
    "rsi": ("Relative Strength Index (RSI)", "parse_number"),
    "average_volume_20d": ("Average Volume (20 Days)", "parse_number"),
    "pe": ("PE Ratio", "parse_number"),
    "pe_forward": ("Forward PE", "parse_number"),
    "peg": ("PEG Ratio", "parse_number"),
    "roic": ("Return on Invested Capital (ROIC)", "parse_percent_ratio"),
    "gross_margin": ("Gross Margin", "parse_percent_ratio"),
    "operating_margin": ("Operating Margin", "parse_percent_ratio"),
    "debt_to_equity": ("Debt / Equity", "parse_number"),
    "debt_to_ebitda": ("Debt / EBITDA", "parse_number"),
    "free_cash_flow": ("Free Cash Flow", "parse_number"),
}


def _extract_quote_block(
    *,
    ticker_lower: str,
    fetch_html: Callable[[str], str | None],
) -> str | None:
    """Extract the embedded quote block from the statistics page."""
    statistics_url = STOCKANALYSIS_STATISTICS_URL.format(ticker=ticker_lower)
    html = fetch_html(statistics_url)
    if html is None:
        return None

    quote_match = QUOTE_BLOCK_PATTERN.search(html)
    if not quote_match:
        return None
    return quote_match.group(1)


def _extract_quote_values(
    quote_block: str,
    field_keys: dict[str, str],
) -> dict[str, float | None]:
    """Parse a set of quote fields from an embedded quote block."""
    return {field_name: parse_number(extract_quote_scalar(quote_block, key) or "") for field_name, key in field_keys.items()}


def scrape_statistics_snapshot(
    *,
    ticker_lower: str,
    fetch_soup: Callable[[str], LexborHTMLParser | None],
) -> StockAnalysisStatistics:
    """Scrape the StockAnalysis statistics table into a snapshot."""
    statistics_url = STOCKANALYSIS_STATISTICS_URL.format(ticker=ticker_lower)
    soup = fetch_soup(statistics_url)
    if soup is None:
        return StockAnalysisStatistics()

    rows = extract_table_rows(soup, cell_selector="th, td", keep_first=True)
    return build_model_from_rows(
        rows,
        model_type=StockAnalysisStatistics,
        field_specs=STATISTICS_FIELD_SPECS,
    )


def scrape_quote_fields(
    *,
    ticker_lower: str,
    fetch_html: Callable[[str], str | None],
) -> dict[str, float | None]:
    """Extract quote fields embedded on the statistics page."""
    quote_block = _extract_quote_block(ticker_lower=ticker_lower, fetch_html=fetch_html)
    if quote_block is None:
        return dict(QUOTE_EMPTY_FIELDS)

    regular_quote = _extract_quote_values(quote_block, REGULAR_QUOTE_KEYS)
    extended_quote = _extract_quote_values(quote_block, EXTENDED_QUOTE_KEYS)
    extended_session = extract_quote_scalar(quote_block, "es")

    if extended_session in EXTENDED_SESSION_NAMES and extended_quote["price"] is not None:
        return extended_quote
    return regular_quote
