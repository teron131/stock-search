"""StockAnalysis statistics page scraping helpers."""

from __future__ import annotations

from collections.abc import Callable

from bs4 import BeautifulSoup

from ..constants import (
    EXTENDED_QUOTE_KEYS,
    EXTENDED_SESSION_NAMES,
    QUOTE_BLOCK_PATTERN,
    QUOTE_EMPTY_FIELDS,
    REGULAR_QUOTE_KEYS,
    STATISTICS_FIELD_SPECS,
    STOCKANALYSIS_STATISTICS_URL,
)
from ..parsing import (
    build_model_from_rows,
    extract_quote_scalar,
    extract_table_rows,
    parse_number,
)
from ..schemas import StockAnalysisStatistics


def scrape_statistics_snapshot(
    *,
    ticker_lower: str,
    fetch_soup: Callable[[str], BeautifulSoup | None],
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


def _extract_quote_block(
    *,
    ticker_lower: str,
    fetch_html: Callable[[str], str | None],
) -> str | None:
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
    return {field_name: parse_number(extract_quote_scalar(quote_block, key) or "") for field_name, key in field_keys.items()}
