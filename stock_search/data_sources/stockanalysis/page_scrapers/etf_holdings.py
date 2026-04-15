"""StockAnalysis ETF holdings page scraping helpers."""

from __future__ import annotations

from collections.abc import Callable
import logging

from selectolax.lexbor import LexborHTMLParser

from stock_search.models import ETFHoldings, Holding

from ..constants import (
    ETF_DATA_SCRIPT_FRAGMENTS,
    HOLDING_ROW_PATTERN,
    HOLDINGS_BLOCK_PATTERN,
    STOCKANALYSIS_ETF_HOLDINGS_URL,
)
from ..parsing import (
    clean_symbol,
    extract_script_block,
    normalize_cell_text,
    parse_percent_points,
)

logger = logging.getLogger(__name__)


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


def _extract_holdings_from_table(
    soup: LexborHTMLParser | None,
) -> list[Holding]:
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
    items_text = extract_script_block(
        soup,
        pattern=HOLDINGS_BLOCK_PATTERN,
        required_fragments=ETF_DATA_SCRIPT_FRAGMENTS,
    )
    if not items_text:
        return []
    return [Holding(ticker=clean_symbol(raw_symbol), name=name, weight=float(weight_str)) for name, raw_symbol, weight_str in HOLDING_ROW_PATTERN.findall(items_text)]
