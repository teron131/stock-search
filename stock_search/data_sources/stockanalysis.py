"""StockAnalysis source adapter.

This module defines URL-based schemas and a provider adapter that returns source-ready snapshots. Cross-source fallback belongs in `indicators.py`.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
import logging
import os
import re
from typing import TypeVar

from bs4 import BeautifulSoup
from llm_harness.clients import WebSearchAgent, WebSearchLoaderAgent
from pydantic import BaseModel, Field
import requests

from stock_search.schemas import ETFHoldings, ETFSectors, Holding

logger = logging.getLogger(__name__)
MODEL_TYPE = TypeVar("MODEL_TYPE")

STOCKANALYSIS_ETF_HOLDINGS_URL = "https://stockanalysis.com/etf/{ticker}/holdings/"
HOLDINGS_BLOCK_PATTERN = re.compile(r"holdings:\[(.*?)\],asset_allocation:", re.DOTALL)
HOLDING_ROW_PATTERN = re.compile(r'\{[^{}]*n:"([^"]+)"[^{}]*s:"([^"]+)"[^{}]*as:"([\d.]+)%"', re.DOTALL)
SECTORS_BLOCK_PATTERN = re.compile(r"sectors:\[(.*?)\],countries:", re.DOTALL)
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

STATISTICS_SYSTEM_PROMPT = """Extract statistics from this page:
https://stockanalysis.com/stocks/{ticker}/statistics/

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

FINANCIALS_SYSTEM_PROMPT = """Extract financial metrics from this page:
https://stockanalysis.com/stocks/{ticker}/financials/

Column-selection rule (mandatory):
- Only extract from the first data column (the current/latest column).
- Ignore all older columns to the right (prior years/quarters).

Normalization rules:
- revenue_growth: ratio (e.g. 23.4% -> 0.234)
- eps_diluted: absolute EPS value
- eps_growth: ratio (e.g. 18.0% -> 0.18)
- gross_margin and operating_margin: ratios (e.g. 52.49% -> 0.5249)
"""

ETF_HOLDINGS_SEARCH_SYSTEM_PROMPT = """Find ETF holdings and weightings for the given ticker.

Rules:
- Use web search to gather holdings from this page first:
  - https://stockanalysis.com/etf/{ticker}/holdings/
- Return holdings only with fields:
  - ticker symbol
  - holding name
  - weight percentage
- Exclude US exchange prefixes.
- Keep non-US exchange prefixes when present.
- If unavailable, return an empty holdings list."""

ETF_SECTOR_SEARCH_SYSTEM_PROMPT = """Find ETF sector allocation percentages for the given ticker.

Rules:
- Use web search to gather the latest ETF sector allocation.
- Only use these pages as sources:
  - https://stockanalysis.com/etf/{ticker}/holdings/
  - https://www.schwab.wallst.com/schwab/Prospect/research/etfs/schwabETF/index.asp?type=holdings&symbol={ticker}
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

    def _load_statistics(self) -> StockAnalysisStatistics:
        """Fetch statistics once and reuse cached data on later calls."""
        if self._statistics_snapshot is None:
            agent = WebSearchLoaderAgent(
                model=os.getenv("QUALITY_LLM"),
                system_prompt=STATISTICS_SYSTEM_PROMPT.format(ticker=self.ticker),
                response_format=StockAnalysisStatistics,
            )
            self._statistics_snapshot = agent.invoke(self.ticker)
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
            agent = WebSearchLoaderAgent(
                model=os.getenv("QUALITY_LLM"),
                system_prompt=FINANCIALS_SYSTEM_PROMPT.format(ticker=self.ticker),
                response_format=StockAnalysisFinancials,
            )
            self._financials_snapshot = agent.invoke(self.ticker)
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
        """Fetch statistics snapshot from StockAnalysis statistics page via LLM."""
        return self._load_statistics()

    @property
    def statistics_fetched_at(self) -> datetime | None:
        """Timestamp of the first successful statistics fetch for this instance."""
        return self._statistics_fetched_at

    def get_financials_snapshot(self) -> StockAnalysisFinancials:
        """Fetch financials snapshot from StockAnalysis financials page via LLM."""
        return self._load_financials()

    @property
    def financials_fetched_at(self) -> datetime | None:
        """Timestamp of the first successful financials fetch for this instance."""
        return self._financials_fetched_at

    def get_etf_holdings_snapshot(self) -> StockAnalysisEtfSnapshot | None:
        """Fetch ETF holdings snapshot using LLM extraction."""
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

    def _fetch_stockanalysis_script_text(self) -> str | None:
        if self._stockanalysis_script_text is not None:
            return self._stockanalysis_script_text

        url = STOCKANALYSIS_ETF_HOLDINGS_URL.format(ticker=self._ticker_lower)
        response = requests.get(url, timeout=20)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
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
            items_text = self._extract_script_block(HOLDINGS_BLOCK_PATTERN)
            if not items_text:
                return holdings

            parsed_holdings: list[Holding] = []
            for name, raw_symbol, weight_str in HOLDING_ROW_PATTERN.findall(items_text):
                ticker = self._clean_symbol(raw_symbol)
                parsed_holdings.append(Holding(ticker=ticker, name=name, weight=float(weight_str)))
            holdings = ETFHoldings(holdings=parsed_holdings)
        except Exception:
            logger.exception("Failed to scrape ETF holdings from StockAnalysis for %s", self.ticker)
        return holdings

    def _search_etf_holdings(self) -> ETFHoldings:
        holdings = ETFHoldings()
        try:
            search_agent = WebSearchAgent(
                model=os.getenv("QUALITY_LLM"),
                temperature=0,
                reasoning_effort="medium",
                system_prompt=ETF_HOLDINGS_SEARCH_SYSTEM_PROMPT.format(ticker=self._ticker_lower),
                response_format=ETFHoldings,
                web_search_engine="exa",
                web_search_max_results=10,
            )
            search_query = f"{self.ticker} ETF holdings weights {STOCKANALYSIS_ETF_HOLDINGS_URL.format(ticker=self._ticker_lower)} -site:yahoo.com -site:finance.yahoo.com"
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
        except Exception:
            logger.exception("Failed to scrape ETF sectors from StockAnalysis for %s", self.ticker)
        return sectors

    def _search_etf_sectors(self) -> ETFSectors:
        sectors = ETFSectors()
        try:
            search_agent = WebSearchAgent(
                model=os.getenv("QUALITY_LLM"),
                temperature=0,
                reasoning_effort="medium",
                system_prompt=ETF_SECTOR_SEARCH_SYSTEM_PROMPT.format(ticker=self._ticker_lower),
                response_format=ETFSectors,
                web_search_engine="exa",
                web_search_max_results=10,
            )
            search_query = (
                f"{self.ticker} ETF sector allocation weights "
                f"{STOCKANALYSIS_ETF_HOLDINGS_URL.format(ticker=self._ticker_lower)} "
                f"{'https://www.schwab.wallst.com/schwab/Prospect/research/etfs/schwabETF/index.asp?type=holdings&symbol=' + self._ticker_lower} "
                "-site:yahoo.com -site:finance.yahoo.com"
            )
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
