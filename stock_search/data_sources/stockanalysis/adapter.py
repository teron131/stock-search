"""StockAnalysis provider adapter implementation."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime
import logging

import httpx
from selectolax.lexbor import LexborHTMLParser

from stock_search.models import ETFHoldings, ETFSectors

from . import page_scrapers
from .exa_fallback import (
    invoke_stockanalysis_search,
    invoke_stockanalysis_search_or_default,
)
from .parsing import (
    coalesce,
    has_model_data,
    to_percent,
)
from .prompts import (
    ETF_HOLDINGS_SEARCH_SYSTEM_PROMPT,
    ETF_SECTOR_SEARCH_SYSTEM_PROMPT,
    FINANCIALS_SYSTEM_PROMPT,
    STATISTICS_SYSTEM_PROMPT,
)
from .schemas import (
    StockAnalysisEtfSnapshot,
    StockAnalysisFinancials,
    StockAnalysisIndicatorsSnapshot,
    StockAnalysisIndustrySnapshot,
    StockAnalysisStatistics,
)

STOCKANALYSIS_STATISTICS_URL = "https://stockanalysis.com/stocks/{ticker}/statistics/"
STOCKANALYSIS_FINANCIALS_URL = "https://stockanalysis.com/stocks/{ticker}/financials/"

logger = logging.getLogger(__name__)


def get_industry_snapshot() -> StockAnalysisIndustrySnapshot:
    """Fetch sector and industry summary rows from the StockAnalysis industries page."""
    return page_scrapers.scrape_industry_snapshot(
        fetch_soup=lambda url: _fetch_stockanalysis_soup(url, subject="industries"),
    )


async def get_industry_snapshot_async() -> StockAnalysisIndustrySnapshot:
    """Async-ready StockAnalysis industries fetch."""
    return await asyncio.to_thread(get_industry_snapshot)


class StockAnalysisSource:
    """Provider-ready StockAnalysis adapter."""

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
        self._page_html_cache: dict[str, str | None] = {}
        self._page_soup_cache: dict[str, LexborHTMLParser | None] = {}

    def load_statistics(self) -> StockAnalysisStatistics:
        """Fetch statistics once and reuse cached data on later calls."""
        return self.load_snapshot(
            label="statistics",
            snapshot_attr="_statistics_snapshot",
            fetched_at_attr="_statistics_fetched_at",
            scrape_getter=self.scrape_statistics_snapshot,
            search_getter=self.search_statistics_snapshot,
        )

    def load_financials(self) -> StockAnalysisFinancials:
        """Fetch financials once and reuse cached data on later calls."""
        return self.load_snapshot(
            label="financials",
            snapshot_attr="_financials_snapshot",
            fetched_at_attr="_financials_fetched_at",
            scrape_getter=self.scrape_financials_snapshot,
            search_getter=self.search_financials_snapshot,
        )

    def load_snapshot[MODEL_TYPE](
        self,
        *,
        label: str,
        snapshot_attr: str,
        fetched_at_attr: str,
        scrape_getter: Callable[[], MODEL_TYPE],
        search_getter: Callable[[], MODEL_TYPE],
    ) -> MODEL_TYPE:
        """Load a cached snapshot or fetch and cache a fresh one."""
        snapshot = getattr(self, snapshot_attr)
        if snapshot is not None:
            fetched_at = getattr(self, fetched_at_attr)
            logger.info(f"Using cached StockAnalysis {label} for {self.ticker} fetched at {fetched_at.isoformat() if fetched_at else 'unknown'}")
            return snapshot

        snapshot = scrape_getter()
        if not has_model_data(snapshot):
            snapshot = search_getter()

        fetched_at = datetime.now(tz=UTC)
        setattr(self, snapshot_attr, snapshot)
        setattr(self, fetched_at_attr, fetched_at)
        logger.info(f"Fetched StockAnalysis {label} for {self.ticker} at {fetched_at.isoformat()}")
        return snapshot

    def get_statistics_snapshot(self) -> StockAnalysisStatistics:
        """Fetch statistics snapshot from the StockAnalysis statistics page."""
        return self.load_statistics()

    async def get_statistics_snapshot_async(self) -> StockAnalysisStatistics:
        """Async-ready ticker-level statistics fetch."""
        return await asyncio.to_thread(self.get_statistics_snapshot)

    @property
    def statistics_fetched_at(self) -> datetime | None:
        """Timestamp of the first successful statistics fetch for this instance."""
        return self._statistics_fetched_at

    def get_financials_snapshot(self) -> StockAnalysisFinancials:
        """Fetch financials snapshot from the StockAnalysis financials page."""
        return self.load_financials()

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

        holdings = self.resolve_with_scrape_fallback_search(
            scrape_getter=self.scrape_etf_holdings,
            search_getter=self.search_etf_holdings,
            has_data=lambda result: bool(result.holdings),
            label="ETF holdings",
        )
        sectors = self.resolve_with_scrape_fallback_search(
            scrape_getter=self.scrape_etf_sectors,
            search_getter=self.search_etf_sectors,
            has_data=has_model_data,
            label="ETF sectors",
        )

        if not holdings.holdings and not has_model_data(sectors):
            return None

        self._etf_snapshot = StockAnalysisEtfSnapshot(
            holdings=holdings,
            sectors=sectors,
        )
        return self._etf_snapshot

    async def get_etf_holdings_snapshot_async(self) -> StockAnalysisEtfSnapshot | None:
        """Async-ready ticker-level ETF holdings fetch."""
        return await asyncio.to_thread(self.get_etf_holdings_snapshot)

    def resolve_with_scrape_fallback_search[MODEL_TYPE](
        self,
        *,
        scrape_getter: Callable[[], MODEL_TYPE],
        search_getter: Callable[[], MODEL_TYPE],
        has_data: Callable[[MODEL_TYPE], bool],
        label: str,
    ) -> MODEL_TYPE:
        """Return scraped data first and fall back to search when needed."""
        scraped = scrape_getter()
        if has_data(scraped):
            return scraped
        logger.info(f"Falling back to web search for {label} ({self.ticker})")
        return search_getter()

    def fetch_stockanalysis_html(self, url: str) -> str | None:
        """Fetch and cache raw HTML for a StockAnalysis page URL."""
        cached_html = self._page_html_cache.get(url)
        if url in self._page_html_cache:
            return cached_html

        html = _fetch_stockanalysis_html(url, subject=self.ticker)
        self._page_html_cache[url] = html
        return html

    def fetch_stockanalysis_soup(self, url: str) -> LexborHTMLParser | None:
        """Fetch and cache a parsed StockAnalysis page tree."""
        if url in self._page_soup_cache:
            return self._page_soup_cache[url]

        html = self.fetch_stockanalysis_html(url)
        if html is None:
            self._page_soup_cache[url] = None
            return None

        soup = LexborHTMLParser(html)
        self._page_soup_cache[url] = soup
        return soup

    def scrape_quote_fields(self) -> dict[str, float | None]:
        """Scrape quote fields from the statistics page payload."""
        return page_scrapers.scrape_quote_fields(
            ticker_lower=self._ticker_lower,
            fetch_html=self.fetch_stockanalysis_html,
        )

    def scrape_statistics_snapshot(self) -> StockAnalysisStatistics:
        """Scrape the statistics page into a structured snapshot."""
        return page_scrapers.scrape_statistics_snapshot(
            ticker_lower=self._ticker_lower,
            fetch_soup=self.fetch_stockanalysis_soup,
        )

    def scrape_financials_snapshot(self) -> StockAnalysisFinancials:
        """Scrape the financials page into a structured snapshot."""
        return page_scrapers.scrape_financials_snapshot(
            ticker_lower=self._ticker_lower,
            fetch_soup=self.fetch_stockanalysis_soup,
        )

    def search_statistics_snapshot(self) -> StockAnalysisStatistics:
        """Use Exa fallback to build a statistics snapshot."""
        statistics_url = STOCKANALYSIS_STATISTICS_URL.format(ticker=self._ticker_lower)
        return invoke_stockanalysis_search(
            output_schema=StockAnalysisStatistics,
            system_prompt_template=STATISTICS_SYSTEM_PROMPT,
            query=f"{statistics_url} {self.ticker} statistics key ratios valuation market cap",
            prompt_values={
                "ticker": self.ticker,
                "statistics_url": statistics_url,
            },
        )

    def search_financials_snapshot(self) -> StockAnalysisFinancials:
        """Use Exa fallback to build a financials snapshot."""
        financials_url = STOCKANALYSIS_FINANCIALS_URL.format(ticker=self._ticker_lower)
        return invoke_stockanalysis_search(
            output_schema=StockAnalysisFinancials,
            system_prompt_template=FINANCIALS_SYSTEM_PROMPT,
            query=f"{financials_url} {self.ticker} financials revenue growth eps growth gross margin",
            prompt_values={
                "ticker": self.ticker,
                "financials_url": financials_url,
            },
        )

    def scrape_etf_holdings(self) -> ETFHoldings:
        """Scrape ETF holdings from the holdings page."""
        return page_scrapers.scrape_etf_holdings(
            ticker=self.ticker,
            ticker_lower=self._ticker_lower,
            fetch_soup=self.fetch_stockanalysis_soup,
        )

    def search_etf_holdings(self) -> ETFHoldings:
        """Use Exa fallback to build ETF holdings data."""
        return invoke_stockanalysis_search_or_default(
            output_schema=ETFHoldings,
            system_prompt_template=ETF_HOLDINGS_SEARCH_SYSTEM_PROMPT,
            query=f"{self.ticker} ETF holdings weights stock analysis",
            prompt_values={"ticker": self._ticker_lower},
            default_factory=ETFHoldings,
            error_message="Failed to extract ETF holdings via web search for %s",
        )

    def scrape_etf_sectors(self) -> ETFSectors:
        """Scrape ETF sectors from the holdings page."""
        return page_scrapers.scrape_etf_sectors(
            ticker=self.ticker,
            ticker_lower=self._ticker_lower,
            fetch_soup=self.fetch_stockanalysis_soup,
        )

    def search_etf_sectors(self) -> ETFSectors:
        """Use Exa fallback to build ETF sector data."""
        return invoke_stockanalysis_search_or_default(
            output_schema=ETFSectors,
            system_prompt_template=ETF_SECTOR_SEARCH_SYSTEM_PROMPT,
            query=f"{self.ticker} ETF sector allocation weights stock analysis schwab",
            prompt_values={"ticker": self._ticker_lower},
            default_factory=ETFSectors,
            error_message="Failed to extract ETF sectors via web search for %s",
        )

    def get_indicators_snapshot(self) -> StockAnalysisIndicatorsSnapshot:
        """Return an app-facing StockAnalysis indicator set (partial by design)."""
        if self._indicators_snapshot is not None:
            return self._indicators_snapshot

        stats = self.get_statistics_snapshot()
        financials = self.get_financials_snapshot()
        quote_fields = self.scrape_quote_fields()
        gross_margin = coalesce(stats.gross_margin, financials.gross_margin)
        operating_margin = coalesce(stats.operating_margin, financials.operating_margin)
        self._indicators_snapshot = StockAnalysisIndicatorsSnapshot(
            price=quote_fields["price"],
            change=quote_fields["change"],
            change_percent_1d=quote_fields["change_percent_1d"],
            market_cap=stats.market_cap,
            pe=stats.pe,
            pe_forward=stats.pe_forward,
            peg=stats.peg,
            beta=stats.beta,
            roic=to_percent(stats.roic),
            revenue_growth=to_percent(financials.revenue_growth),
            gross_margin=to_percent(gross_margin),
            operating_margin=to_percent(operating_margin),
            debt_to_equity=to_percent(stats.debt_to_equity),
            debt_to_ebitda=stats.debt_to_ebitda,
            free_cash_flow=stats.free_cash_flow,
            eps_diluted=financials.eps_diluted,
            eps_growth=to_percent(financials.eps_growth),
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


def _fetch_stockanalysis_html(url: str, *, subject: str) -> str | None:
    """Fetch raw HTML for one StockAnalysis page."""
    try:
        response = httpx.get(url, timeout=20)
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        status_code = exc.response.status_code
        if status_code == 404:
            logger.info(f"StockAnalysis page not found for {subject} ({url})")
        else:
            logger.warning(f"StockAnalysis request failed for {subject} (status={status_code}, url={url})")
        return None
    except httpx.RequestError as exc:
        logger.warning(f"StockAnalysis request failed for {subject} (url={url}): {exc}")
        return None
    return response.text


def _fetch_stockanalysis_soup(url: str, *, subject: str) -> LexborHTMLParser | None:
    """Fetch and parse one StockAnalysis page."""
    html = _fetch_stockanalysis_html(url, subject=subject)
    if html is None:
        return None
    return LexborHTMLParser(html)
