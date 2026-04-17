"""StockAnalysis ETF holdings page scraping helpers."""

from __future__ import annotations

from collections.abc import Callable
import logging
import re

from selectolax.lexbor import LexborHTMLParser

from stock_search.models import ETFHoldings, ETFSectors, Holding

from ..parsing import (
    clean_symbol,
    extract_script_block,
    normalize_cell_text,
    parse_percent_points,
)

logger = logging.getLogger(__name__)

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


def _holdings_url(ticker_lower: str) -> str:
    """Build the StockAnalysis holdings page URL for an ETF ticker."""
    return STOCKANALYSIS_ETF_HOLDINGS_URL.format(ticker=ticker_lower)


def _extract_holdings_from_table(
    soup: LexborHTMLParser | None,
) -> list[Holding]:
    """Extract ETF holdings from the holdings table."""
    if soup is None:
        return []

    holdings: list[Holding] = []
    for row in soup.css("table tr"):
        cells = row.css("td")
        if len(cells) < 4:
            continue
        ticker = normalize_cell_text(cells[1].text(separator=" ", strip=True))
        name = normalize_cell_text(cells[2].text(separator=" ", strip=True))
        weight = parse_percent_points(cells[3].text(separator=" ", strip=True))
        if ticker and weight is not None:
            holdings.append(Holding(ticker=ticker, name=name or None, weight=weight))
    return holdings


def _extract_holdings_from_script(
    soup: LexborHTMLParser | None,
) -> list[Holding]:
    """Extract ETF holdings from the embedded page script."""
    holdings_block_text = _extract_holdings_block(soup)
    if not holdings_block_text:
        return []
    return [Holding(ticker=clean_symbol(raw_symbol), name=name, weight=float(weight_str)) for name, raw_symbol, weight_str in HOLDING_ROW_PATTERN.findall(holdings_block_text)]


def _extract_holdings_block(soup: LexborHTMLParser | None) -> str | None:
    """Extract the holdings block from the ETF holdings page script."""
    return extract_script_block(
        soup,
        pattern=HOLDINGS_BLOCK_PATTERN,
        required_fragments=ETF_DATA_SCRIPT_FRAGMENTS,
    )


def _extract_sectors_block(soup: LexborHTMLParser | None) -> str | None:
    """Extract the sectors block from the ETF holdings page script."""
    return extract_script_block(
        soup,
        pattern=SECTORS_BLOCK_PATTERN,
        required_fragments=ETF_DATA_SCRIPT_FRAGMENTS,
    )


def scrape_etf_holdings(
    *,
    ticker: str,
    ticker_lower: str,
    fetch_soup: Callable[[str], LexborHTMLParser | None],
) -> ETFHoldings:
    """Scrape ETF holdings from the StockAnalysis holdings page."""
    try:
        holdings_url = STOCKANALYSIS_ETF_HOLDINGS_URL.format(ticker=ticker_lower)
        soup = fetch_soup(holdings_url)
        parsed_holdings = _extract_holdings_from_table(soup)
        if not parsed_holdings:
            parsed_holdings = _extract_holdings_from_script(soup)
        return ETFHoldings(holdings=parsed_holdings)
    except Exception as exc:
        logger.warning(
            "Failed to scrape ETF holdings from StockAnalysis for %s: %s",
            ticker,
            exc,
        )
    return ETFHoldings()


def scrape_etf_sectors(
    *,
    ticker: str,
    ticker_lower: str,
    fetch_soup: Callable[[str], LexborHTMLParser | None],
) -> ETFSectors:
    """Scrape ETF sector allocation from the StockAnalysis holdings page."""
    try:
        items_text = _extract_sectors_block(
            fetch_soup(_holdings_url(ticker_lower)),
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
