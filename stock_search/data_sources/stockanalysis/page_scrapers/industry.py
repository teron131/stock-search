"""StockAnalysis industries page scraping helpers."""

from __future__ import annotations

from collections.abc import Callable
import logging
from urllib.parse import urlparse

from selectolax.lexbor import LexborHTMLParser, LexborNode

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
STOCKANALYSIS_INDUSTRY_ALL_URL = "https://stockanalysis.com/stocks/industry/all/"
STOCKANALYSIS_INDUSTRY_TABLE_ID = "industries"
AGGREGATION_FIELDS = {
    "ch1m": "change_percent_1m",
    "grossMargin": "gross_margin",
}


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
    table: LexborNode,
    sector_name: str,
) -> tuple[
    list[StockAnalysisIndustrySummary],
    dict[str, StockAnalysisIndustrySummary],
]:
    """Extract one sector table into industry summary rows."""
    industries: list[StockAnalysisIndustrySummary] = []
    industries_by_slug: dict[str, StockAnalysisIndustrySummary] = {}
    for row in table.css("tbody tr"):
        cells = row.css("td")
        if len(cells) < 8:
            continue

        industry_name = normalize_cell_text(cells[0].text(separator=" ", strip=True))
        stock_count = _parse_stock_count(cells[1].text(separator=" ", strip=True))
        if not industry_name or stock_count is None:
            continue

        industry = StockAnalysisIndustrySummary(
            sector=sector_name,
            industry=industry_name,
            stock_count=stock_count,
            market_cap=parse_number(cells[2].text(separator=" ", strip=True)),
            pe=parse_number(cells[4].text(separator=" ", strip=True)),
            gross_margin=None,
            profit_margin=parse_percent_points(cells[5].text(separator=" ", strip=True)),
            change_percent_1d=parse_percent_points(cells[6].text(separator=" ", strip=True)),
            change_percent_1m=None,
            change_percent_1y=parse_percent_points(cells[7].text(separator=" ", strip=True)),
        )
        industries.append(industry)

        slug = _extract_industry_slug(row)
        if slug:
            industries_by_slug[slug] = industry
    return industries, industries_by_slug


def _extract_all_page_industry_slugs(soup: LexborHTMLParser) -> list[str]:
    """Extract industry slugs from the flat all-industries page."""
    slugs: list[str] = []
    for row in soup.css("table tbody tr"):
        slug = _extract_industry_slug(row)
        if slug:
            slugs.append(slug)
    return slugs


def _extract_grouped_industries(
    soup: LexborHTMLParser,
) -> tuple[
    list[StockAnalysisIndustrySummary],
    dict[str, StockAnalysisIndustrySummary],
]:
    """Extract grouped industries plus a slug lookup from the sector-organized page."""
    sector_names = _extract_sector_names(soup)
    tables = soup.css("table")
    if not sector_names or not tables:
        return [], {}

    if len(sector_names) != len(tables):
        logger.warning(f"Sector/table count mismatch on StockAnalysis industries page (sectors={len(sector_names)}, tables={len(tables)})")

    industries: list[StockAnalysisIndustrySummary] = []
    industries_by_slug: dict[str, StockAnalysisIndustrySummary] = {}
    for sector_name, table in zip(sector_names, tables, strict=False):
        sector_industries, sector_industries_by_slug = _extract_sector_rows(
            table,
            sector_name,
        )
        industries.extend(sector_industries)
        industries_by_slug.update(sector_industries_by_slug)
    return industries, industries_by_slug


def _extract_industry_slug(row: LexborNode) -> str | None:
    """Extract the stable industry slug from the first linked cell."""
    link = row.css_first("td a")
    if link is None:
        return None
    href = link.attributes.get("href")
    if not href:
        return None
    return _normalize_industry_slug(href)


def _normalize_industry_slug(href: str) -> str | None:
    """Normalize an industry href into its slug."""
    path = urlparse(href).path.strip("/")
    if not path:
        return None
    return path.split("/")[-1] or None


def _build_aggregation_values_by_slug(
    *,
    all_page_slugs: list[str],
    aggregation_rows: list[dict[str, float | None]],
) -> dict[str, dict[str, float | None]]:
    """Build aggregation values keyed by stable industry slug."""
    if len(all_page_slugs) != len(aggregation_rows):
        logger.warning(f"Industry aggregation order mismatch (all_page_slugs={len(all_page_slugs)}, aggregation_rows={len(aggregation_rows)})")
        return {}

    return dict(
        zip(
            all_page_slugs,
            aggregation_rows,
            strict=False,
        )
    )


def _apply_aggregation_fields(
    industries_by_slug: dict[str, StockAnalysisIndustrySummary],
    aggregation_values_by_slug: dict[str, dict[str, float | None]],
) -> None:
    """Apply optional aggregation values onto grouped industries by slug."""
    for slug, aggregation_values in aggregation_values_by_slug.items():
        industry = industries_by_slug.get(slug)
        if industry is None:
            continue
        for column_name, field_name in AGGREGATION_FIELDS.items():
            setattr(industry, field_name, aggregation_values.get(column_name))


def _parse_stock_count(raw_value: str) -> int | None:
    """Parse the industry stock-count column."""
    parsed_value = parse_number(raw_value)
    return int(parsed_value) if parsed_value is not None else None


def scrape_industry_snapshot(
    *,
    fetch_soup: Callable[[str], LexborHTMLParser | None],
    fetch_aggregation_rows: Callable[[str, list[str]], list[dict[str, float | None]]],
) -> StockAnalysisIndustrySnapshot:
    """Scrape sector and industry summary rows from the StockAnalysis industries page."""
    try:
        soup = fetch_soup(STOCKANALYSIS_INDUSTRY_URL)
        if soup is None:
            return StockAnalysisIndustrySnapshot()

        industries, industries_by_slug = _extract_grouped_industries(soup)
        if not industries:
            return StockAnalysisIndustrySnapshot()

        all_page_soup = fetch_soup(STOCKANALYSIS_INDUSTRY_ALL_URL)
        all_page_slugs = _extract_all_page_industry_slugs(all_page_soup) if all_page_soup is not None else []
        aggregation_rows = fetch_aggregation_rows(
            STOCKANALYSIS_INDUSTRY_TABLE_ID,
            list(AGGREGATION_FIELDS),
        )
        aggregation_values_by_slug = _build_aggregation_values_by_slug(
            all_page_slugs=all_page_slugs,
            aggregation_rows=aggregation_rows,
        )
        _apply_aggregation_fields(
            industries_by_slug,
            aggregation_values_by_slug,
        )

        return StockAnalysisIndustrySnapshot(industries=industries)
    except Exception as exc:
        logger.warning(f"Failed to scrape StockAnalysis industries page: {exc}")
        return StockAnalysisIndustrySnapshot()
