"""StockAnalysis source adapter.

This module defines URL-based schemas and a provider adapter that returns source-ready snapshots. Cross-source fallback belongs in `indicators.py`.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
import logging
import re
from typing import TypeVar

from bs4 import BeautifulSoup
import httpx
from llm_harness.clients import ExaAgent
from pydantic import BaseModel, Field

from stock_search.models import ETFHoldings, ETFSectors, Holding

logger = logging.getLogger(__name__)
MODEL_TYPE = TypeVar("MODEL_TYPE")

STOCKANALYSIS_STATISTICS_URL = "https://stockanalysis.com/stocks/{ticker}/statistics/"
STOCKANALYSIS_FINANCIALS_URL = "https://stockanalysis.com/stocks/{ticker}/financials/"
STOCKANALYSIS_ETF_HOLDINGS_URL = "https://stockanalysis.com/etf/{ticker}/holdings/"

HOLDINGS_BLOCK_PATTERN = re.compile(r"holdings:\[(.*?)\],asset_allocation:", re.DOTALL)
HOLDING_ROW_PATTERN = re.compile(r'\{[^{}]*n:"([^"]+)"[^{}]*s:"([^"]+)"[^{}]*as:"([\d.]+)%"', re.DOTALL)
SECTORS_BLOCK_PATTERN = re.compile(r"sectors:\[(.*?)\],(?:countries|allocationChartData):", re.DOTALL)
SECTOR_ROW_PATTERN = re.compile(r'\{n:"([^"]+)",w:([\d.]+)\}')
COMPACT_NUMBER_SUFFIXES = {
    "K": 1_000.0,
    "M": 1_000_000.0,
    "B": 1_000_000_000.0,
    "T": 1_000_000_000_000.0,
}
NULLISH_TEXT = {"", "-", "n/a", "N/A", "na", "NA"}
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


class StockAnalysisStatistics(BaseModel):
    """Structured output schema for the StockAnalysis statistics page.

    Source page:
    https://stockanalysis.com/stocks/{ticker}/statistics/

    All fields default to `None` by design so extraction can degrade safely when
    values are missing or unclear in the page layout.
    """

    # Market and price behavior
    market_cap: float | None = Field(default=None, description="Market Cap")
    beta: float | None = Field(default=None, description="Beta (5Y)")
    fifty_two_week_price_change: float | None = Field(default=None, description="52-Week Price Change")
    moving_average_50d: float | None = Field(default=None, description="50-Day Moving Average")
    moving_average_200d: float | None = Field(default=None, description="200-Day Moving Average")
    rsi: float | None = Field(default=None, description="Relative Strength Index (RSI)")
    average_volume_20d: float | None = Field(default=None, description="Average Volume (20 Days)")
    # Valuation
    pe: float | None = Field(default=None, description="PE Ratio")
    pe_forward: float | None = Field(default=None, description="Forward PE")
    peg: float | None = Field(default=None, description="PEG Ratio")
    # Profitability and balance-sheet efficiency
    roic: float | None = Field(default=None, description="Return on Invested Capital (ROIC)")
    gross_margin: float | None = Field(default=None, description="Gross Margin")
    operating_margin: float | None = Field(default=None, description="Operating Margin")
    debt_to_ebitda: float | None = Field(default=None, description="Debt / EBITDA")
    free_cash_flow: float | None = Field(default=None, description="Free Cash Flow")


class StockAnalysisFinancials(BaseModel):
    """Structured output schema for the StockAnalysis financials page.

    Source page:
    https://stockanalysis.com/stocks/{ticker}/financials/

    All fields default to `None` by design so extraction can degrade safely when
    values are missing or unclear in the page layout.
    """

    # Growth and per-share metrics from the financials page
    revenue_growth: float | None = Field(default=None, description="Revenue Growth (YoY)")
    eps_diluted: float | None = Field(default=None, description="EPS (Diluted)")
    eps_growth: float | None = Field(default=None, description="EPS Growth")
    # Also available on this URL and used as overlap fallback
    gross_margin: float | None = Field(default=None, description="Gross Margin")
    operating_margin: float | None = Field(default=None, description="Operating Margin")


@dataclass(frozen=True)
class StockAnalysisEtfSnapshot:
    """ETF holdings snapshot extracted from supported holdings pages."""

    holdings: ETFHoldings
    sectors: ETFSectors


class StockAnalysisIndicatorsSnapshot(
    StockAnalysisStatistics,
    StockAnalysisFinancials,
):
    """Indicator payload that combines statistics and financials schemas.

    This model inherits page-level fields from both URL-based schemas and adds
    normalized indicator aliases consumed by `indicators.py`.
    """

    # Snapshot metadata used by orchestrator/callers.
    fetched_at: str | None = Field(default=None)


class StockAnalysisSource:
    """Provider-ready StockAnalysis adapter.

    The module currently focuses on ETF data and may return sparse statistics.
    """

    def __init__(self, ticker: str):
        """Initialize source adapter for a single ticker."""
        self.ticker = ticker.upper().strip()
        self._ticker_lower = self.ticker.lower()
        self._statistics_snapshot: StockAnalysisStatistics | None = None
        self._statistics_fetched_at: datetime | None = None
        self._financials_snapshot: StockAnalysisFinancials | None = None
        self._financials_fetched_at: datetime | None = None
        self._etf_snapshot: StockAnalysisEtfSnapshot | None = None
        self._indicators_snapshot: StockAnalysisIndicatorsSnapshot | None = None
        self._stockanalysis_script_text: str | None = None
        self._page_html_cache: dict[str, str | None] = {}

    def _load_statistics(self) -> StockAnalysisStatistics:
        """Fetch statistics once and reuse cached data on later calls."""
        if self._statistics_snapshot is None:
            self._statistics_snapshot = self._scrape_statistics_snapshot()
            if not self._has_model_data(self._statistics_snapshot):
                self._statistics_snapshot = self._search_statistics_snapshot()
            self._statistics_fetched_at = datetime.now(tz=UTC)
            logger.info(
                "Fetched StockAnalysis statistics for %s at %s",
                self.ticker,
                self._statistics_fetched_at.isoformat(),
            )
            return self._statistics_snapshot

        logger.info(
            "Using cached StockAnalysis statistics for %s fetched at %s",
            self.ticker,
            self._statistics_fetched_at.isoformat() if self._statistics_fetched_at else "unknown",
        )
        return self._statistics_snapshot

    def _load_financials(self) -> StockAnalysisFinancials:
        """Fetch financials once and reuse cached data on later calls."""
        if self._financials_snapshot is None:
            self._financials_snapshot = self._scrape_financials_snapshot()
            if not self._has_model_data(self._financials_snapshot):
                self._financials_snapshot = self._search_financials_snapshot()
            self._financials_fetched_at = datetime.now(tz=UTC)
            logger.info(
                "Fetched StockAnalysis financials for %s at %s",
                self.ticker,
                self._financials_fetched_at.isoformat(),
            )
            return self._financials_snapshot

        logger.info(
            "Using cached StockAnalysis financials for %s fetched at %s",
            self.ticker,
            self._financials_fetched_at.isoformat() if self._financials_fetched_at else "unknown",
        )
        return self._financials_snapshot

    @staticmethod
    def _coalesce(primary: float | None, fallback: float | None) -> float | None:
        return primary if primary is not None else fallback

    @staticmethod
    def _to_percent(value: float | None) -> float | None:
        return value * 100 if value is not None else None

    def get_statistics_snapshot(self) -> StockAnalysisStatistics:
        """Fetch statistics snapshot from the StockAnalysis statistics page."""
        return self._load_statistics()

    async def get_statistics_snapshot_async(self) -> StockAnalysisStatistics:
        """Async-ready ticker-level statistics fetch."""
        return await asyncio.to_thread(self.get_statistics_snapshot)

    @property
    def statistics_fetched_at(self) -> datetime | None:
        """Timestamp of the first successful statistics fetch for this instance."""
        return self._statistics_fetched_at

    def get_financials_snapshot(self) -> StockAnalysisFinancials:
        """Fetch financials snapshot from the StockAnalysis financials page."""
        return self._load_financials()

    async def get_financials_snapshot_async(self) -> StockAnalysisFinancials:
        """Async-ready ticker-level financials fetch."""
        return await asyncio.to_thread(self.get_financials_snapshot)

    @property
    def financials_fetched_at(self) -> datetime | None:
        """Timestamp of the first successful financials fetch for this instance."""
        return self._financials_fetched_at

    def get_etf_holdings_snapshot(self) -> StockAnalysisEtfSnapshot | None:
        """Fetch ETF holdings snapshot using scrape-first extraction."""
        if self._etf_snapshot is not None:
            return self._etf_snapshot

        holdings = self._resolve_with_scrape_fallback_search(
            scrape_getter=self._scrape_stockanalysis_holdings,
            search_getter=self._search_etf_holdings,
            has_data=lambda result: bool(result.holdings),
            label="ETF holdings",
        )
        sectors = self._resolve_with_scrape_fallback_search(
            scrape_getter=self._scrape_stockanalysis_sectors,
            search_getter=self._search_etf_sectors,
            has_data=self._has_sector_data,
            label="ETF sectors",
        )

        if not holdings.holdings and not self._has_sector_data(sectors):
            return None

        self._etf_snapshot = StockAnalysisEtfSnapshot(holdings=holdings, sectors=sectors)
        return self._etf_snapshot

    async def get_etf_holdings_snapshot_async(self) -> StockAnalysisEtfSnapshot | None:
        """Async-ready ticker-level ETF holdings fetch."""
        return await asyncio.to_thread(self.get_etf_holdings_snapshot)

    @staticmethod
    def _has_sector_data(sectors: ETFSectors) -> bool:
        return any(weight is not None for weight in sectors.model_dump().values())

    def _resolve_with_scrape_fallback_search(
        self,
        *,
        scrape_getter: Callable[[], MODEL_TYPE],
        search_getter: Callable[[], MODEL_TYPE],
        has_data: Callable[[MODEL_TYPE], bool],
        label: str,
    ) -> MODEL_TYPE:
        scraped = scrape_getter()
        if has_data(scraped):
            return scraped
        logger.info("Falling back to web search for %s (%s)", label, self.ticker)
        return search_getter()

    @staticmethod
    def _clean_symbol(raw_symbol: str) -> str:
        symbol = raw_symbol.strip()
        if symbol.startswith("$"):
            return symbol[1:]
        if symbol.startswith("!") and "/" in symbol:
            return symbol.split("/", maxsplit=1)[1]
        if symbol.startswith("!"):
            return symbol[1:]
        return symbol

    @staticmethod
    def _has_model_data(model: BaseModel) -> bool:
        return any(value is not None for value in model.model_dump().values())

    @staticmethod
    def _normalize_cell_text(text: str) -> str:
        return " ".join(text.split())

    @staticmethod
    def _clean_numeric_text(raw_value: str) -> str | None:
        text = raw_value.strip()
        if text in NULLISH_TEXT:
            return None
        if text.startswith("(") and text.endswith(")"):
            text = f"-{text[1:-1]}"
        return text.replace(",", "").replace("$", "").replace("+", "")

    @classmethod
    def _parse_number(cls, raw_value: str) -> float | None:
        text = cls._clean_numeric_text(raw_value)
        if text is None:
            return None
        multiplier = 1.0
        suffix = text[-1].upper()
        if suffix in COMPACT_NUMBER_SUFFIXES:
            multiplier = COMPACT_NUMBER_SUFFIXES[suffix]
            text = text[:-1]
        try:
            return float(text) * multiplier
        except ValueError:
            return None

    @classmethod
    def _parse_percent_ratio(cls, raw_value: str) -> float | None:
        text = cls._clean_numeric_text(raw_value)
        if text is None:
            return None
        if text.endswith("%"):
            text = text[:-1]
        try:
            return float(text) / 100.0
        except ValueError:
            return None

    @classmethod
    def _parse_percent_points(cls, raw_value: str) -> float | None:
        text = cls._clean_numeric_text(raw_value)
        if text is None:
            return None
        if text.endswith("%"):
            text = text[:-1]
        try:
            return float(text)
        except ValueError:
            return None

    def _fetch_stockanalysis_html(self, url: str) -> str | None:
        cached_html = self._page_html_cache.get(url)
        if url in self._page_html_cache:
            return cached_html

        try:
            response = httpx.get(url, timeout=20)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code
            if status_code == 404:
                logger.info("StockAnalysis page not found for %s (%s)", self.ticker, url)
            else:
                logger.warning("StockAnalysis request failed for %s (status=%s, url=%s)", self.ticker, status_code, url)
            self._page_html_cache[url] = None
            return None
        except httpx.RequestError as exc:
            logger.warning("StockAnalysis request failed for %s (url=%s): %s", self.ticker, url, exc)
            self._page_html_cache[url] = None
            return None

        self._page_html_cache[url] = response.text
        return response.text

    def _fetch_stockanalysis_soup(self, url: str) -> BeautifulSoup | None:
        html = self._fetch_stockanalysis_html(url)
        if html is None:
            return None
        return BeautifulSoup(html, "html.parser")

    def _extract_two_column_table_rows(self, soup: BeautifulSoup) -> dict[str, str]:
        rows: dict[str, str] = {}
        for row in soup.select("table tr"):
            cells = row.select("th, td")
            if len(cells) < 2:
                continue
            label = self._normalize_cell_text(cells[0].get_text(" ", strip=True))
            value = self._normalize_cell_text(cells[1].get_text(" ", strip=True))
            if label and value and label not in rows:
                rows[label] = value
        return rows

    def _extract_first_value_rows(self, soup: BeautifulSoup) -> dict[str, str]:
        rows: dict[str, str] = {}
        for row in soup.select("table tr"):
            cells = row.select("td")
            if len(cells) < 2:
                continue
            label = self._normalize_cell_text(cells[0].get_text(" ", strip=True))
            value = self._normalize_cell_text(cells[1].get_text(" ", strip=True))
            if label and value:
                rows[label] = value
        return rows

    def _scrape_statistics_snapshot(self) -> StockAnalysisStatistics:
        statistics_url = STOCKANALYSIS_STATISTICS_URL.format(ticker=self._ticker_lower)
        soup = self._fetch_stockanalysis_soup(statistics_url)
        if soup is None:
            return StockAnalysisStatistics()

        rows = self._extract_two_column_table_rows(soup)
        return StockAnalysisStatistics(
            market_cap=self._parse_number(rows.get("Market Cap", "")),
            beta=self._parse_number(rows.get("Beta (5Y)", "")),
            fifty_two_week_price_change=self._parse_percent_points(rows.get("52-Week Price Change", "")),
            moving_average_50d=self._parse_number(rows.get("50-Day Moving Average", "")),
            moving_average_200d=self._parse_number(rows.get("200-Day Moving Average", "")),
            rsi=self._parse_number(rows.get("Relative Strength Index (RSI)", "")),
            average_volume_20d=self._parse_number(rows.get("Average Volume (20 Days)", "")),
            pe=self._parse_number(rows.get("PE Ratio", "")),
            pe_forward=self._parse_number(rows.get("Forward PE", "")),
            peg=self._parse_number(rows.get("PEG Ratio", "")),
            roic=self._parse_percent_ratio(rows.get("Return on Invested Capital (ROIC)", "")),
            gross_margin=self._parse_percent_ratio(rows.get("Gross Margin", "")),
            operating_margin=self._parse_percent_ratio(rows.get("Operating Margin", "")),
            debt_to_ebitda=self._parse_number(rows.get("Debt / EBITDA", "")),
            free_cash_flow=self._parse_number(rows.get("Free Cash Flow", "")),
        )

    def _scrape_financials_snapshot(self) -> StockAnalysisFinancials:
        financials_url = STOCKANALYSIS_FINANCIALS_URL.format(ticker=self._ticker_lower)
        soup = self._fetch_stockanalysis_soup(financials_url)
        if soup is None:
            return StockAnalysisFinancials()

        rows = self._extract_first_value_rows(soup)
        return StockAnalysisFinancials(
            revenue_growth=self._parse_percent_ratio(rows.get("Revenue Growth (YoY)", "")),
            eps_diluted=self._parse_number(rows.get("EPS (Diluted)", "")),
            eps_growth=self._parse_percent_ratio(rows.get("EPS Growth", "")),
            gross_margin=self._parse_percent_ratio(rows.get("Gross Margin", "")),
            operating_margin=self._parse_percent_ratio(rows.get("Operating Margin", "")),
        )

    def _search_statistics_snapshot(self) -> StockAnalysisStatistics:
        statistics_url = STOCKANALYSIS_STATISTICS_URL.format(ticker=self._ticker_lower)
        agent = ExaAgent(
            system_prompt=STATISTICS_SYSTEM_PROMPT.format(
                ticker=self.ticker,
                statistics_url=statistics_url,
            ),
            output_schema=StockAnalysisStatistics,
        )
        query = f"{statistics_url} {self.ticker} statistics key ratios valuation market cap"
        return agent.invoke(query)

    def _search_financials_snapshot(self) -> StockAnalysisFinancials:
        financials_url = STOCKANALYSIS_FINANCIALS_URL.format(ticker=self._ticker_lower)
        agent = ExaAgent(
            system_prompt=FINANCIALS_SYSTEM_PROMPT.format(
                ticker=self.ticker,
                financials_url=financials_url,
            ),
            output_schema=StockAnalysisFinancials,
        )
        query = f"{financials_url} {self.ticker} financials revenue growth eps growth gross margin"
        return agent.invoke(query)

    def _fetch_stockanalysis_script_text(self) -> str | None:
        if self._stockanalysis_script_text is not None:
            return self._stockanalysis_script_text

        url = STOCKANALYSIS_ETF_HOLDINGS_URL.format(ticker=self._ticker_lower)
        soup = self._fetch_stockanalysis_soup(url)
        if soup is None:
            return None

        for script_tag in soup.find_all("script"):
            script_text = script_tag.get_text()
            if "holdings:[" in script_text and "sectors:[" in script_text:
                self._stockanalysis_script_text = script_text
                return self._stockanalysis_script_text
        return None

    def _extract_script_block(self, pattern: re.Pattern[str]) -> str | None:
        script_text = self._fetch_stockanalysis_script_text()
        if not script_text:
            return None

        block_match = pattern.search(script_text)
        if not block_match:
            return None
        return block_match.group(1)

    def _scrape_stockanalysis_holdings(self) -> ETFHoldings:
        holdings = ETFHoldings()
        try:
            parsed_holdings: list[Holding] = []
            holdings_url = STOCKANALYSIS_ETF_HOLDINGS_URL.format(ticker=self._ticker_lower)
            soup = self._fetch_stockanalysis_soup(holdings_url)
            if soup is not None:
                for row in soup.select("table tr"):
                    cells = row.select("td")
                    if len(cells) < 4:
                        continue
                    ticker = self._normalize_cell_text(cells[1].get_text(" ", strip=True))
                    name = self._normalize_cell_text(cells[2].get_text(" ", strip=True))
                    weight = self._parse_percent_points(cells[3].get_text(" ", strip=True))
                    if ticker and weight is not None:
                        parsed_holdings.append(Holding(ticker=ticker, name=name or None, weight=weight))

            if not parsed_holdings:
                items_text = self._extract_script_block(HOLDINGS_BLOCK_PATTERN)
                if not items_text:
                    return holdings
                for name, raw_symbol, weight_str in HOLDING_ROW_PATTERN.findall(items_text):
                    ticker = self._clean_symbol(raw_symbol)
                    parsed_holdings.append(Holding(ticker=ticker, name=name, weight=float(weight_str)))

            holdings = ETFHoldings(holdings=parsed_holdings)
        except Exception as exc:
            logger.warning("Failed to scrape ETF holdings from StockAnalysis for %s: %s", self.ticker, exc)
        return holdings

    def _search_etf_holdings(self) -> ETFHoldings:
        holdings = ETFHoldings()
        try:
            search_agent = ExaAgent(
                system_prompt=ETF_HOLDINGS_SEARCH_SYSTEM_PROMPT.format(ticker=self._ticker_lower),
                output_schema=ETFHoldings,
            )
            search_query = f"{self.ticker} ETF holdings weights stock analysis"
            search_result = search_agent.invoke(search_query)
            if isinstance(search_result, ETFHoldings):
                holdings = search_result
        except Exception:
            logger.exception("Failed to extract ETF holdings via web search for %s", self.ticker)
        return holdings

    def _scrape_stockanalysis_sectors(self) -> ETFSectors:
        sectors = ETFSectors()
        try:
            items_text = self._extract_script_block(SECTORS_BLOCK_PATTERN)
            if not items_text:
                return sectors

            payload: dict[str, float] = {}
            for sector_name, weight_str in SECTOR_ROW_PATTERN.findall(items_text):
                field_name = SECTOR_FIELD_BY_LABEL.get(sector_name)
                if field_name:
                    payload[field_name] = float(weight_str)
            if payload:
                sectors = ETFSectors(**payload)
        except Exception as exc:
            logger.warning("Failed to scrape ETF sectors from StockAnalysis for %s: %s", self.ticker, exc)
        return sectors

    def _search_etf_sectors(self) -> ETFSectors:
        sectors = ETFSectors()
        try:
            search_agent = ExaAgent(
                system_prompt=ETF_SECTOR_SEARCH_SYSTEM_PROMPT.format(ticker=self._ticker_lower),
                output_schema=ETFSectors,
            )
            search_query = f"{self.ticker} ETF sector allocation weights stock analysis schwab"
            search_result = search_agent.invoke(search_query)
            if isinstance(search_result, ETFSectors):
                sectors = search_result
        except Exception:
            logger.exception("Failed to extract ETF sectors via web search for %s", self.ticker)
        return sectors

    def get_indicators_snapshot(self) -> StockAnalysisIndicatorsSnapshot:
        """Return StockAnalysis indicator set (partial by design)."""
        if self._indicators_snapshot is not None:
            return self._indicators_snapshot

        stats = self.get_statistics_snapshot()
        financials = self.get_financials_snapshot()
        gross_margin = self._coalesce(stats.gross_margin, financials.gross_margin)
        operating_margin = self._coalesce(stats.operating_margin, financials.operating_margin)
        self._indicators_snapshot = StockAnalysisIndicatorsSnapshot(
            market_cap=stats.market_cap,
            pe=stats.pe,
            pe_forward=stats.pe_forward,
            peg=stats.peg,
            beta=stats.beta,
            roic=self._to_percent(stats.roic),
            revenue_growth=self._to_percent(financials.revenue_growth),
            gross_margin=self._to_percent(gross_margin),
            operating_margin=self._to_percent(operating_margin),
            debt_to_ebitda=stats.debt_to_ebitda,
            free_cash_flow=stats.free_cash_flow,
            eps_diluted=financials.eps_diluted,
            eps_growth=self._to_percent(financials.eps_growth),
            fifty_two_week_price_change=stats.fifty_two_week_price_change,
            moving_average_50d=stats.moving_average_50d,
            moving_average_200d=stats.moving_average_200d,
            rsi=stats.rsi,
            average_volume_20d=stats.average_volume_20d,
            fetched_at=self._statistics_fetched_at.isoformat() if self._statistics_fetched_at else None,
        )
        return self._indicators_snapshot

    async def get_indicators_snapshot_async(self) -> StockAnalysisIndicatorsSnapshot:
        """Async-ready ticker-level indicators fetch."""
        return await asyncio.to_thread(self.get_indicators_snapshot)
