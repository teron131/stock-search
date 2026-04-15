"""Provider-local schemas for StockAnalysis extraction snapshots."""

from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, Field

from stock_search.models import ETFHoldings, ETFSectors


class StockAnalysisStatistics(BaseModel):
    """Structured output schema for the StockAnalysis statistics page."""

    market_cap: float | None = Field(default=None, description="Market Cap")
    beta: float | None = Field(default=None, description="Beta (5Y)")
    fifty_two_week_price_change: float | None = Field(
        default=None,
        description="52-Week Price Change",
    )
    moving_average_50d: float | None = Field(
        default=None,
        description="50-Day Moving Average",
    )
    moving_average_200d: float | None = Field(
        default=None,
        description="200-Day Moving Average",
    )
    rsi: float | None = Field(default=None, description="Relative Strength Index (RSI)")
    average_volume_20d: float | None = Field(
        default=None,
        description="Average Volume (20 Days)",
    )
    pe: float | None = Field(default=None, description="PE Ratio")
    pe_forward: float | None = Field(default=None, description="Forward PE")
    peg: float | None = Field(default=None, description="PEG Ratio")
    roic: float | None = Field(
        default=None,
        description="Return on Invested Capital (ROIC)",
    )
    gross_margin: float | None = Field(default=None, description="Gross Margin")
    operating_margin: float | None = Field(
        default=None,
        description="Operating Margin",
    )
    debt_to_equity: float | None = Field(default=None, description="Debt / Equity")
    debt_to_ebitda: float | None = Field(default=None, description="Debt / EBITDA")
    free_cash_flow: float | None = Field(default=None, description="Free Cash Flow")


class StockAnalysisFinancials(BaseModel):
    """Structured output schema for the StockAnalysis financials page."""

    revenue_growth: float | None = Field(
        default=None,
        description="Revenue Growth (YoY)",
    )
    eps_diluted: float | None = Field(default=None, description="EPS (Diluted)")
    eps_growth: float | None = Field(default=None, description="EPS Growth")
    gross_margin: float | None = Field(default=None, description="Gross Margin")
    operating_margin: float | None = Field(
        default=None,
        description="Operating Margin",
    )


@dataclass(frozen=True)
class StockAnalysisEtfSnapshot:
    """ETF holdings snapshot extracted from supported holdings pages."""

    holdings: ETFHoldings
    sectors: ETFSectors


class StockAnalysisIndicatorsSnapshot(
    StockAnalysisStatistics,
    StockAnalysisFinancials,
):
    """Combined StockAnalysis indicator payload used by `indicators.py`."""

    price: float | None = Field(default=None)
    change: float | None = Field(default=None)
    change_percent: float | None = Field(default=None)
    fetched_at: str | None = Field(default=None)
