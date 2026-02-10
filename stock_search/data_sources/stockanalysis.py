"""StockAnalysis source adapter.

This module currently focuses on ETF holdings extraction and intentionally returns sparse statistics snapshots. Missing fields are expected and surfaced as `None` for downstream fallback orchestration.
"""

from __future__ import annotations

from dataclasses import dataclass
import os

from llm_harness.clients import WebLoaderAgent

from stock_search.schemas import ETFHoldings

ETF_HOLDINGS_SYSTEM_PROMPT = """Extract ETF holdings and weightings from these websites:
https://stockanalysis.com/etf/{ticker}/holdings
https://www.schwab.wallst.com/schwab/Prospect/research/etfs/schwabETF/index.asp?type=holdings&symbol={ticker}
https://www.tradingview.com/symbols/{ticker}/holdings

Holdings: ticker symbol, name, weight percentage.

Exclude the exchange prefix from the ticker symbol if it is in the US.
Only include the exchange prefix from the ticker symbol if it is not in the US, such as 'EPA:HO', '1329.T'."""


@dataclass(frozen=True)
class StockAnalysisStatisticsSnapshot:
    """Statistics page snapshot.

    This source is intentionally partial for now; fields can be None.
    """

    forward_pe: float | None = None
    trailing_pe: float | None = None
    peg_ratio: float | None = None
    market_cap: float | None = None
    beta_5y: float | None = None
    gross_margin: float | None = None  # ratio, e.g. 0.52
    debt_to_equity: float | None = None  # ratio, e.g. 0.06


@dataclass(frozen=True)
class StockAnalysisEtfSnapshot:
    """ETF holdings snapshot extracted from supported holdings pages."""

    holdings: ETFHoldings


@dataclass(frozen=True)
class StockAnalysisIndicatorsSnapshot:
    """Indicator-shaped payload produced by StockAnalysis source."""

    market_cap: float | None = None
    pe: float | None = None
    pe_forward: float | None = None
    peg: float | None = None
    beta: float | None = None
    revenue_growth: float | None = None
    gross_margin: float | None = None
    debt_to_equity: float | None = None
    free_cash_flow: float | None = None


class StockAnalysisSource:
    """Provider-ready StockAnalysis adapter.

    The module currently focuses on ETF data and may return sparse statistics.
    """

    def __init__(self, ticker: str):
        """Initialize source adapter for a single ticker."""
        self.ticker = ticker.upper().strip()
        self._statistics_snapshot: StockAnalysisStatisticsSnapshot | None = None
        self._etf_snapshot: StockAnalysisEtfSnapshot | None = None
        self._indicators_snapshot: StockAnalysisIndicatorsSnapshot | None = None

    def get_statistics_snapshot(self) -> StockAnalysisStatisticsSnapshot:
        """Return sparse statistics snapshot (placeholder for partial coverage)."""
        # This provider remains intentionally sparse for now.
        if self._statistics_snapshot is None:
            self._statistics_snapshot = StockAnalysisStatisticsSnapshot()
        return self._statistics_snapshot

    def get_etf_holdings_snapshot(self) -> StockAnalysisEtfSnapshot | None:
        """Fetch ETF holdings snapshot using LLM extraction."""
        if self._etf_snapshot is not None:
            return self._etf_snapshot

        agent = WebLoaderAgent(
            model=os.getenv("QUALITY_LLM"),
            reasoning_effort="low",
            system_prompt=ETF_HOLDINGS_SYSTEM_PROMPT.format(ticker=self.ticker),
            response_format=ETFHoldings,
        )
        try:
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
        gross_margin = (stats.gross_margin * 100) if stats.gross_margin is not None else None
        debt_to_equity = (stats.debt_to_equity * 100) if stats.debt_to_equity is not None else None
        self._indicators_snapshot = StockAnalysisIndicatorsSnapshot(
            market_cap=stats.market_cap,
            pe=stats.trailing_pe,
            pe_forward=stats.forward_pe,
            peg=stats.peg_ratio,
            beta=stats.beta_5y,
            gross_margin=gross_margin,
            debt_to_equity=debt_to_equity,
        )
        return self._indicators_snapshot
