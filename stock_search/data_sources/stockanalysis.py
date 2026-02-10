"""StockAnalysis source adapter.

This module defines URL-based schemas and a provider adapter that returns source-ready snapshots. Cross-source fallback belongs in `indicators.py`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import logging
import os

from llm_harness.clients import WebLoaderAgent
from pydantic import BaseModel, Field

from stock_search.schemas import ETFHoldings

logger = logging.getLogger(__name__)

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

ETF_HOLDINGS_SYSTEM_PROMPT = """Extract ETF holdings and weightings from these websites:
https://stockanalysis.com/etf/{ticker}/holdings
https://www.schwab.wallst.com/schwab/Prospect/research/etfs/schwabETF/index.asp?type=holdings&symbol={ticker}
https://www.tradingview.com/symbols/{ticker}/holdings

Holdings: ticker symbol, name, weight percentage.

Exclude the exchange prefix from the ticker symbol if it is in the US.
Only include the exchange prefix from the ticker symbol if it is not in the US, such as 'EPA:HO', '1329.T'."""


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
        self._statistics_snapshot: StockAnalysisStatistics | None = None
        self._statistics_fetched_at: datetime | None = None
        self._financials_snapshot: StockAnalysisFinancials | None = None
        self._financials_fetched_at: datetime | None = None
        self._etf_snapshot: StockAnalysisEtfSnapshot | None = None
        self._indicators_snapshot: StockAnalysisIndicatorsSnapshot | None = None

    def _load_statistics(self) -> StockAnalysisStatistics:
        """Fetch statistics once and reuse cached data on later calls."""
        if self._statistics_snapshot is None:
            agent = WebLoaderAgent(
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
            agent = WebLoaderAgent(
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
        try:
            agent = WebLoaderAgent(
                model=os.getenv("QUALITY_LLM"),
                system_prompt=ETF_HOLDINGS_SYSTEM_PROMPT.format(ticker=self.ticker),
                response_format=ETFHoldings,
            )
            holdings = agent.invoke(self.ticker)
        except Exception:
            return None

        self._etf_snapshot = StockAnalysisEtfSnapshot(holdings=holdings)
        return self._etf_snapshot

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
