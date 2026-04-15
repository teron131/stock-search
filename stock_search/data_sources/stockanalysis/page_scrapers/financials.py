"""StockAnalysis financials page scraping helpers."""

from __future__ import annotations

from collections.abc import Callable

from selectolax.lexbor import LexborHTMLParser

from ..constants import (
    FINANCIALS_FIELD_SPECS,
    STOCKANALYSIS_FINANCIALS_URL,
)
from ..parsing import build_model_from_rows, extract_table_rows
from ..schemas import StockAnalysisFinancials


def scrape_financials_snapshot(
    *,
    ticker_lower: str,
    fetch_soup: Callable[[str], LexborHTMLParser | None],
) -> StockAnalysisFinancials:
    """Scrape the StockAnalysis financials table into a snapshot."""
    financials_url = STOCKANALYSIS_FINANCIALS_URL.format(ticker=ticker_lower)
    soup = fetch_soup(financials_url)
    if soup is None:
        return StockAnalysisFinancials()

    rows = extract_table_rows(soup, cell_selector="td", keep_first=False)
    return build_model_from_rows(
        rows,
        model_type=StockAnalysisFinancials,
        field_specs=FINANCIALS_FIELD_SPECS,
    )
