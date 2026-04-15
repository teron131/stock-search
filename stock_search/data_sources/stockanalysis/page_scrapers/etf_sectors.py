"""StockAnalysis ETF sectors page scraping helpers."""

from __future__ import annotations

from collections.abc import Callable
import logging

from bs4 import BeautifulSoup

from stock_search.models import ETFSectors

from ..constants import (
    ETF_DATA_SCRIPT_FRAGMENTS,
    SECTOR_FIELD_BY_LABEL,
    SECTOR_ROW_PATTERN,
    SECTORS_BLOCK_PATTERN,
    STOCKANALYSIS_ETF_HOLDINGS_URL,
)
from ..parsing import extract_script_block

logger = logging.getLogger(__name__)


def scrape_etf_sectors(
    *,
    ticker: str,
    ticker_lower: str,
    fetch_soup: Callable[[str], BeautifulSoup | None],
) -> ETFSectors:
    """Scrape ETF sector allocation from the StockAnalysis holdings page."""
    try:
        holdings_url = STOCKANALYSIS_ETF_HOLDINGS_URL.format(ticker=ticker_lower)
        items_text = extract_script_block(
            fetch_soup(holdings_url),
            pattern=SECTORS_BLOCK_PATTERN,
            required_fragments=ETF_DATA_SCRIPT_FRAGMENTS,
        )
        if not items_text:
            return ETFSectors()

        payload = {field_name: float(weight_str) for sector_name, weight_str in SECTOR_ROW_PATTERN.findall(items_text) if (field_name := SECTOR_FIELD_BY_LABEL.get(sector_name))}
        if payload:
            return ETFSectors(**payload)
    except Exception as exc:
        logger.warning(
            "Failed to scrape ETF sectors from StockAnalysis for %s: %s",
            ticker,
            exc,
        )
    return ETFSectors()
