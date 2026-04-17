"""Provider-local schemas for StockAnalysis extraction snapshots."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from stock_search.models import ETFHoldings, ETFSectors


class StockAnalysisStatistics(BaseModel):
    """Raw StockAnalysis statistics page payload before adapter normalization."""

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
        description="Return on Invested Capital (ROIC) as a 0-1 ratio",
    )
    gross_margin: float | None = Field(
        default=None,
        description="Gross margin as a 0-1 ratio",
    )
    operating_margin: float | None = Field(
        default=None,
        description="Operating margin as a 0-1 ratio",
    )
    debt_to_equity: float | None = Field(default=None, description="Debt / Equity")
    debt_to_ebitda: float | None = Field(default=None, description="Debt / EBITDA")
    free_cash_flow: float | None = Field(default=None, description="Free Cash Flow")


class StockAnalysisFinancials(BaseModel):
    """Raw StockAnalysis financials-page payload before adapter normalization."""

    revenue_growth: float | None = Field(
        default=None,
        description="Revenue growth (YoY) as a 0-1 ratio",
    )
    eps_diluted: float | None = Field(default=None, description="EPS (Diluted)")
    eps_growth: float | None = Field(default=None, description="EPS growth as a 0-1 ratio")
    gross_margin: float | None = Field(
        default=None,
        description="Gross margin as a 0-1 ratio",
    )
    operating_margin: float | None = Field(
        default=None,
        description="Operating margin as a 0-1 ratio",
    )


class StockAnalysisIndustrySummary(BaseModel):
    """One sector/industry summary row from the StockAnalysis industries page."""

    sector: str = Field(description="Sector name")
    industry: str = Field(description="Industry name")
    stock_count: int = Field(description="Number of stocks in the industry")
    market_cap: float | None = Field(default=None, description="Industry market cap")
    pe: float | None = Field(default=None, description="Industry PE ratio")
    profit_margin: float | None = Field(
        default=None,
        description="Industry profit margin percent",
    )
    gross_margin: float | None = Field(
        default=None,
        description="Industry gross margin percent",
    )
    change_percent_1d: float | None = Field(
        default=None,
        description="1-day change percent",
    )
    change_percent_1m: float | None = Field(
        default=None,
        description="1-month change percent",
    )
    change_percent_1y: float | None = Field(
        default=None,
        description="1-year change percent",
    )


class StockAnalysisIndustrySnapshot(BaseModel):
    """Structured output schema for the StockAnalysis industries page."""

    industries: list[StockAnalysisIndustrySummary] = Field(
        default_factory=list,
        description="Industry summary rows grouped by sector",
    )


class StockAnalysisEtfSnapshot(BaseModel):
    """ETF holdings snapshot extracted from supported holdings pages."""

    model_config = ConfigDict(frozen=True)

    holdings: ETFHoldings = Field(
        description="ETF holdings table extracted from the supported holdings page.",
    )
    sectors: ETFSectors = Field(
        description="ETF sector allocation breakdown extracted from the supported holdings page.",
    )


class StockAnalysisIndicatorsSnapshot(
    StockAnalysisStatistics,
    StockAnalysisFinancials,
):
    """App-facing StockAnalysis indicator payload used by `indicators.py`.

    Percent-based fields in this model use percent units.
    """

    price: float | None = Field(default=None)
    change: float | None = Field(default=None)
    change_percent_1d: float | None = Field(default=None, description="1-day price change percent")
    revenue_growth: float | None = Field(default=None, description="Revenue growth (YoY) percent")
    gross_margin: float | None = Field(default=None, description="Gross margin percent")
    operating_margin: float | None = Field(default=None, description="Operating margin percent")
    eps_growth: float | None = Field(default=None, description="EPS growth percent")
    fetched_at: str | None = Field(default=None)
