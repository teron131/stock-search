"""StockAnalysis industries page scraping helpers."""

from __future__ import annotations

from collections.abc import Callable
import logging

from selectolax.lexbor import LexborHTMLParser

from ..parsing import (
    normalize_cell_text,
    parse_number,
    parse_percent_points,
)
from ..schemas import (
    StockAnalysisIndustrySnapshot,
    StockAnalysisIndustrySummary,
)

logger = logging.getLogger(__name__)

STOCKANALYSIS_INDUSTRY_URL = "https://stockanalysis.com/stocks/industry/"


def _extract_sector_names(soup: LexborHTMLParser) -> list[str]:
    """Extract sector names in document order from page headings."""
    sector_names: list[str] = []
    for heading in soup.css("h2"):
        heading_text = normalize_cell_text(heading.text(separator=" ", strip=True))
        if not heading_text.startswith("Sector:"):
            continue
        sector_name = heading_text.removeprefix("Sector:").strip()
        if sector_name:
            sector_names.append(sector_name)
    return sector_names


def _extract_sector_rows(
    table: object,
    sector_name: str,
) -> list[StockAnalysisIndustrySummary]:
    """Extract one sector table into industry summary rows."""
    rows: list[StockAnalysisIndustrySummary] = []
    for row in table.css("tbody tr"):
        cells = row.css("td")
        if len(cells) < 8:
            continue

        industry_name = normalize_cell_text(cells[0].text(separator=" ", strip=True))
        stock_count = _parse_stock_count(cells[1].text(separator=" ", strip=True))
        if not industry_name or stock_count is None:
            continue

        rows.append(
            StockAnalysisIndustrySummary(
                sector=sector_name,
                industry=industry_name,
                stock_count=stock_count,
                market_cap=parse_number(cells[2].text(separator=" ", strip=True)),
                pe=parse_number(cells[4].text(separator=" ", strip=True)),
                profit_margin=parse_percent_points(cells[5].text(separator=" ", strip=True)),
                change_percent_1d=parse_percent_points(cells[6].text(separator=" ", strip=True)),
                change_percent_1m=None,
                change_percent_1y=parse_percent_points(cells[7].text(separator=" ", strip=True)),
            )
        )
    return rows


def _parse_stock_count(raw_value: str) -> int | None:
    """Parse the industry stock-count column."""
    parsed_value = parse_number(raw_value)
    return int(parsed_value) if parsed_value is not None else None


def scrape_industry_snapshot(
    *,
    fetch_soup: Callable[[str], LexborHTMLParser | None],
) -> StockAnalysisIndustrySnapshot:
    """Scrape sector and industry summary rows from the StockAnalysis industries page."""
    try:
        soup = fetch_soup(STOCKANALYSIS_INDUSTRY_URL)
        if soup is None:
            return StockAnalysisIndustrySnapshot()

        sector_names = _extract_sector_names(soup)
        tables = soup.css("table")
        if not sector_names or not tables:
            return StockAnalysisIndustrySnapshot()

        if len(sector_names) != len(tables):
            logger.warning(f"Sector/table count mismatch on StockAnalysis industries page (sectors={len(sector_names)}, tables={len(tables)})")

        industries: list[StockAnalysisIndustrySummary] = []
        for sector_name, table in zip(sector_names, tables, strict=False):
            industries.extend(_extract_sector_rows(table, sector_name))

        return StockAnalysisIndustrySnapshot(industries=industries)
    except Exception as exc:
        logger.warning(f"Failed to scrape StockAnalysis industries page: {exc}")
        return StockAnalysisIndustrySnapshot()
