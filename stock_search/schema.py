from typing import Annotated, Literal

from pydantic import BaseModel, Field

# Common Fields
Ticker = Annotated[str, Field(description="Ticker")]
Weight = Annotated[float, Field(description="Weight as a percentage (0-100)")]


class Quote(BaseModel):
    """Real-time and regular market quotes."""

    ticker: Ticker = Field(description="Ticker symbol")
    regular_price: float | None = Field(default=None, description="Regular market price")
    regular_change: float | None = Field(default=None, description="Regular market price change")
    regular_change_percent: float | None = Field(default=None, description="Regular market price change percent")
    realtime_price: float | None = Field(default=None, description="Pre/post market price")
    realtime_change: float | None = Field(default=None, description="Pre/post market price change")
    realtime_change_percent: float | None = Field(default=None, description="Pre/post market price change percent")


class Holding(BaseModel):
    """A single holding within an ETF."""

    ticker: Ticker
    weight: Weight


class Sector(BaseModel):
    """Industry sector allocation."""

    sector: Literal[
        "Technology",
        "Materials",
        "Financials",
        "Healthcare",
        "Industrials",
        "Real Estate",
        "Energy",
        "Utilities",
        "Consumer Discretionary",
        "Communication Services",
        "Consumer Staples",
        "Other",
    ] = Field(description="Standardized sector name")
    weight: Weight


class ETF(BaseModel):
    """ETF-specific metadata including holdings and sector breakdown."""

    top_holdings: list[Holding] = Field(default_factory=list, description="Top holdings list")
    sectors: list[Sector] = Field(default_factory=list, description="Sector allocation list")


class NewsAnalysis(BaseModel):
    """Structured analysis of a financial news article."""

    summary: str = Field(
        default="",
        description="Detailed summary; exclude noise/ads and meta-language.",
    )
    relevancy: Literal["high", "medium", "low"] = Field(
        default="medium",
        description="How relevant the news is to the target ticker.",
    )
    category: Literal[
        "macro_economics",
        "industry_news",
        "market_news",
        "company_news",
        "earnings",
        "analyst_rating",
        "analysis",
        "other",
    ] = Field(
        default="other",
        description="Category of the news.",
    )
    sentiment: Literal[
        "bullish",
        "neutral",
        "bearish",
    ] = Field(
        default="neutral",
        description="Market sentiment from the news.",
    )


class News(NewsAnalysis):
    """Full news article data including analysis results."""

    title: str = Field(description="Headline")
    url: str = Field(description="Source URL")
    date: str = Field(description="Publication date (YYYY-MM-DD)")
    days_ago: int | None = Field(default=None, description="Days since publication")


class PortfolioPosition(BaseModel):
    """A single portfolio position with notional exposure metrics."""

    ticker: Ticker
    quantity: float | None = Field(default=None, description="Number of shares or contracts")
    delta: float | None = Field(default=None, description="Option delta (1.0 for shares)")
    current_price: float | None = Field(default=None, description="Current market price")
    bucket: Literal["core_engine", "core_satellite", "fomo", "defensive"] = Field(description="Portfolio strategy bucket")


class Portfolio(BaseModel):
    """Aggregate portfolio data."""

    total_equity: float | None = Field(default=None, description="Total portfolio equity")
    positions: list[PortfolioPosition] = Field(default_factory=list, description="Portfolio positions list")
