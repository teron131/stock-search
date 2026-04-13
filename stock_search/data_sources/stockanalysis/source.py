"""StockAnalysis provider adapter implementation."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime
import logging
import re

from bs4 import BeautifulSoup
import httpx

from stock_search.models import ETFHoldings, ETFSectors, Holding

from .constants import (
    ETF_HOLDINGS_SEARCH_SYSTEM_PROMPT,
    ETF_SECTOR_SEARCH_SYSTEM_PROMPT,
    EXTENDED_QUOTE_KEYS,
    EXTENDED_SESSION_NAMES,
    FINANCIALS_FIELD_SPECS,
    FINANCIALS_SYSTEM_PROMPT,
    HOLDING_ROW_PATTERN,
    HOLDINGS_BLOCK_PATTERN,
    QUOTE_BLOCK_PATTERN,
    QUOTE_EMPTY_FIELDS,
    REGULAR_QUOTE_KEYS,
    SECTOR_FIELD_BY_LABEL,
    SECTOR_ROW_PATTERN,
    SECTORS_BLOCK_PATTERN,
    STATISTICS_FIELD_SPECS,
    STATISTICS_SYSTEM_PROMPT,
    STOCKANALYSIS_ETF_HOLDINGS_URL,
    STOCKANALYSIS_FINANCIALS_URL,
    STOCKANALYSIS_STATISTICS_URL,
)
from .exa_fallback import (
    invoke_stockanalysis_search,
    invoke_stockanalysis_search_or_default,
)
from .parsing import (
    build_model_from_rows,
    clean_symbol,
    coalesce,
    extract_quote_scalar,
    extract_table_rows,
    has_model_data,
    has_sector_data,
    normalize_cell_text,
    parse_number,
    parse_percent_points,
    to_percent,
)
from .schemas import (
    StockAnalysisEtfSnapshot,
    StockAnalysisFinancials,
    StockAnalysisIndicatorsSnapshot,
    StockAnalysisStatistics,
)

logger = logging.getLogger(__name__)


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
        self._stockanalysis_script_text: str | None = None
        self._page_html_cache: dict[str, str | None] = {}

    def _load_statistics(self) -> StockAnalysisStatistics:
        """Fetch statistics once and reuse cached data on later calls."""
        return self._load_snapshot(
            label="statistics",
            snapshot_attr="_statistics_snapshot",
            fetched_at_attr="_statistics_fetched_at",
            scrape_getter=self._scrape_statistics_snapshot,
            search_getter=self._search_statistics_snapshot,
        )

    def _load_financials(self) -> StockAnalysisFinancials:
        """Fetch financials once and reuse cached data on later calls."""
        return self._load_snapshot(
            label="financials",
            snapshot_attr="_financials_snapshot",
            fetched_at_attr="_financials_fetched_at",
            scrape_getter=self._scrape_financials_snapshot,
            search_getter=self._search_financials_snapshot,
        )

    def _load_snapshot[MODEL_TYPE](
        self,
        *,
        label: str,
        snapshot_attr: str,
        fetched_at_attr: str,
        scrape_getter: Callable[[], MODEL_TYPE],
        search_getter: Callable[[], MODEL_TYPE],
    ) -> MODEL_TYPE:
        snapshot = getattr(self, snapshot_attr)
        if snapshot is not None:
            fetched_at = getattr(self, fetched_at_attr)
            logger.info(
                "Using cached StockAnalysis %s for %s fetched at %s",
                label,
                self.ticker,
                fetched_at.isoformat() if fetched_at else "unknown",
            )
            return snapshot

        snapshot = scrape_getter()
        if not has_model_data(snapshot):
            snapshot = search_getter()

        fetched_at = datetime.now(tz=UTC)
        setattr(self, snapshot_attr, snapshot)
        setattr(self, fetched_at_attr, fetched_at)
        logger.info(
            "Fetched StockAnalysis %s for %s at %s",
            label,
            self.ticker,
            fetched_at.isoformat(),
        )
        return snapshot

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
            has_data=has_sector_data,
            label="ETF sectors",
        )

        if not holdings.holdings and not has_sector_data(sectors):
            return None

        self._etf_snapshot = StockAnalysisEtfSnapshot(
            holdings=holdings,
            sectors=sectors,
        )
        return self._etf_snapshot

    async def get_etf_holdings_snapshot_async(self) -> StockAnalysisEtfSnapshot | None:
        """Async-ready ticker-level ETF holdings fetch."""
        return await asyncio.to_thread(self.get_etf_holdings_snapshot)

    def _resolve_with_scrape_fallback_search[MODEL_TYPE](
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
                logger.warning(
                    "StockAnalysis request failed for %s (status=%s, url=%s)",
                    self.ticker,
                    status_code,
                    url,
                )
            self._page_html_cache[url] = None
            return None
        except httpx.RequestError as exc:
            logger.warning(
                "StockAnalysis request failed for %s (url=%s): %s",
                self.ticker,
                url,
                exc,
            )
            self._page_html_cache[url] = None
            return None

        self._page_html_cache[url] = response.text
        return response.text

    def _fetch_stockanalysis_soup(self, url: str) -> BeautifulSoup | None:
        html = self._fetch_stockanalysis_html(url)
        if html is None:
            return None
        return BeautifulSoup(html, "html.parser")

    def _extract_quote_block(self) -> str | None:
        statistics_url = STOCKANALYSIS_STATISTICS_URL.format(ticker=self._ticker_lower)
        html = self._fetch_stockanalysis_html(statistics_url)
        if html is None:
            return None

        quote_match = QUOTE_BLOCK_PATTERN.search(html)
        if not quote_match:
            return None
        return quote_match.group(1)

    def _scrape_quote_fields(self) -> dict[str, float | None]:
        quote_block = self._extract_quote_block()
        if quote_block is None:
            return dict(QUOTE_EMPTY_FIELDS)

        regular_quote = self._extract_quote_values(quote_block, REGULAR_QUOTE_KEYS)
        extended_quote = self._extract_quote_values(quote_block, EXTENDED_QUOTE_KEYS)
        extended_session = extract_quote_scalar(quote_block, "es")

        if extended_session in EXTENDED_SESSION_NAMES and extended_quote["price"] is not None:
            return extended_quote
        return regular_quote

    def _extract_quote_values(
        self,
        quote_block: str,
        field_keys: dict[str, str],
    ) -> dict[str, float | None]:
        return {field_name: parse_number(extract_quote_scalar(quote_block, key) or "") for field_name, key in field_keys.items()}

    def _scrape_statistics_snapshot(self) -> StockAnalysisStatistics:
        statistics_url = STOCKANALYSIS_STATISTICS_URL.format(ticker=self._ticker_lower)
        soup = self._fetch_stockanalysis_soup(statistics_url)
        if soup is None:
            return StockAnalysisStatistics()

        rows = extract_table_rows(soup, cell_selector="th, td", keep_first=True)
        return build_model_from_rows(
            rows,
            model_type=StockAnalysisStatistics,
            field_specs=STATISTICS_FIELD_SPECS,
        )

    def _scrape_financials_snapshot(self) -> StockAnalysisFinancials:
        financials_url = STOCKANALYSIS_FINANCIALS_URL.format(ticker=self._ticker_lower)
        soup = self._fetch_stockanalysis_soup(financials_url)
        if soup is None:
            return StockAnalysisFinancials()

        rows = extract_table_rows(soup, cell_selector="td", keep_first=False)
        return build_model_from_rows(
            rows,
            model_type=StockAnalysisFinancials,
            field_specs=FINANCIALS_FIELD_SPECS,
        )

    def _search_statistics_snapshot(self) -> StockAnalysisStatistics:
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

    def _search_financials_snapshot(self) -> StockAnalysisFinancials:
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
        try:
            holdings_url = STOCKANALYSIS_ETF_HOLDINGS_URL.format(ticker=self._ticker_lower)
            soup = self._fetch_stockanalysis_soup(holdings_url)
            parsed_holdings = self._extract_holdings_from_table(soup)
            if not parsed_holdings:
                parsed_holdings = self._extract_holdings_from_script()
            return ETFHoldings(holdings=parsed_holdings)
        except Exception as exc:
            logger.warning(
                "Failed to scrape ETF holdings from StockAnalysis for %s: %s",
                self.ticker,
                exc,
            )
        return ETFHoldings()

    def _extract_holdings_from_table(
        self,
        soup: BeautifulSoup | None,
    ) -> list[Holding]:
        if soup is None:
            return []

        holdings: list[Holding] = []
        for row in soup.select("table tr"):
            cells = row.select("td")
            if len(cells) < 4:
                continue
            ticker = normalize_cell_text(cells[1].get_text(" ", strip=True))
            name = normalize_cell_text(cells[2].get_text(" ", strip=True))
            weight = parse_percent_points(cells[3].get_text(" ", strip=True))
            if ticker and weight is not None:
                holdings.append(Holding(ticker=ticker, name=name or None, weight=weight))
        return holdings

    def _extract_holdings_from_script(self) -> list[Holding]:
        items_text = self._extract_script_block(HOLDINGS_BLOCK_PATTERN)
        if not items_text:
            return []
        return [Holding(ticker=clean_symbol(raw_symbol), name=name, weight=float(weight_str)) for name, raw_symbol, weight_str in HOLDING_ROW_PATTERN.findall(items_text)]

    def _search_etf_holdings(self) -> ETFHoldings:
        return invoke_stockanalysis_search_or_default(
            output_schema=ETFHoldings,
            system_prompt_template=ETF_HOLDINGS_SEARCH_SYSTEM_PROMPT,
            query=f"{self.ticker} ETF holdings weights stock analysis",
            prompt_values={"ticker": self._ticker_lower},
            default_factory=ETFHoldings,
            error_message="Failed to extract ETF holdings via web search for %s",
        )

    def _scrape_stockanalysis_sectors(self) -> ETFSectors:
        try:
            items_text = self._extract_script_block(SECTORS_BLOCK_PATTERN)
            if not items_text:
                return ETFSectors()

            payload = {
                field_name: float(weight_str) for sector_name, weight_str in SECTOR_ROW_PATTERN.findall(items_text) if (field_name := SECTOR_FIELD_BY_LABEL.get(sector_name))
            }
            if payload:
                return ETFSectors(**payload)
        except Exception as exc:
            logger.warning(
                "Failed to scrape ETF sectors from StockAnalysis for %s: %s",
                self.ticker,
                exc,
            )
        return ETFSectors()

    def _search_etf_sectors(self) -> ETFSectors:
        return invoke_stockanalysis_search_or_default(
            output_schema=ETFSectors,
            system_prompt_template=ETF_SECTOR_SEARCH_SYSTEM_PROMPT,
            query=f"{self.ticker} ETF sector allocation weights stock analysis schwab",
            prompt_values={"ticker": self._ticker_lower},
            default_factory=ETFSectors,
            error_message="Failed to extract ETF sectors via web search for %s",
        )

    def get_indicators_snapshot(self) -> StockAnalysisIndicatorsSnapshot:
        """Return StockAnalysis indicator set (partial by design)."""
        if self._indicators_snapshot is not None:
            return self._indicators_snapshot

        stats = self.get_statistics_snapshot()
        financials = self.get_financials_snapshot()
        quote_fields = self._scrape_quote_fields()
        gross_margin = coalesce(stats.gross_margin, financials.gross_margin)
        operating_margin = coalesce(stats.operating_margin, financials.operating_margin)
        self._indicators_snapshot = StockAnalysisIndicatorsSnapshot(
            price=quote_fields["price"],
            change=quote_fields["change"],
            change_percent=quote_fields["change_percent"],
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
