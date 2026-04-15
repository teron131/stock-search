"""StockAnalysis ETF sectors page scraping helpers."""

from __future__ import annotations

from collections.abc import Callable
import logging
import re

from stock_search.models import ETFSectors

from ..constants import (
    SECTOR_FIELD_BY_LABEL,
    SECTOR_ROW_PATTERN,
    SECTORS_BLOCK_PATTERN,
)

logger = logging.getLogger(__name__)


def scrape_etf_sectors(
    *,
    ticker: str,
    extract_script_block: Callable[[re.Pattern[str]], str | None],
) -> ETFSectors:
    """Scrape ETF sector allocation from the StockAnalysis holdings page."""
    try:
        items_text = extract_script_block(SECTORS_BLOCK_PATTERN)
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
