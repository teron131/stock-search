import re
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator

# Common Fields
Ticker = Annotated[str, Field(description="Stock ticker symbol (e.g., 'NVDA', 'AAPL')")]
Weight = Annotated[float, Field(description="Weight percentage")]


class Quote(BaseModel):
    """Real-time and regular market quotes."""

    symbol: Ticker | None = None
    regular_price: float | None = Field(default=None, description="The regular market price")
    regular_change: float | None = Field(default=None, description="The regular market price change")
    regular_change_percent: float | None = Field(default=None, description="The regular market price change percentage")
    realtime_price: float | None = Field(default=None, description="Pre/post market price")
    realtime_change: float | None = Field(default=None, description="Pre/post market price change")
    realtime_change_percent: float | None = Field(default=None, description="Pre/post market price change percentage")


class Holding(BaseModel):
    """A single holding within an ETF."""

    symbol: Ticker = Field(description="Ticker symbol of the holding")
    holding: str = Field(description="Full name of the holding")
    weight: Weight


class Sector(BaseModel):
    """Industry sector allocation."""

    sector: str = Field(description="Name of the sector")
    weight: Weight


class ETF(BaseModel):
    """ETF-specific metadata including holdings and sector breakdown."""

    top_holdings: list[Holding] = Field(default_factory=list, description="List of top holdings")
    sectors: list[Sector] = Field(default_factory=list, description="Sector allocation breakdown")


class NewsAnalysis(BaseModel):
    """Structured analysis of a financial news article."""

    summary: str = Field(
        default="",
        description="Detailed description of news, excluding noise/ads. Avoid meta-language like 'The article mentions...'",
    )
    tickers: list[Ticker] = Field(
        default_factory=list,
        description="Stock tickers mentioned in the article.",
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
        description="Primary focus of the news.",
    )
    sentiment: Literal[
        "bullish",
        "neutral",
        "bearish",
    ] = Field(
        default="neutral",
        description="Market sentiment for the primary subject.",
    )

    @field_validator("tickers")
    @classmethod
    def validate_tickers(cls, v: list[str]) -> list[str]:
        ticker_pattern = re.compile(r"^[A-Z]{1,5}$")
        return [ticker for ticker in v if ticker_pattern.match(ticker)]


class News(NewsAnalysis):
    """Full news article data including analysis results."""

    title: str = Field(description="Headline of the article")
    url: str = Field(description="Source URL")
    date: str = Field(description="Publication date (YYYY-MM-DD HH:MM:SS)")
    relevance: Literal["strong", "weak", "irrelevant"] = Field(
        default="irrelevant",
        description="Article relevance based on ticker density.",
    )


class PortfolioPosition(BaseModel):
    """A single portfolio position with notional exposure metrics."""

    ticker: Ticker
    quantity: float = Field(description="Number of shares or contracts")
    delta: float = Field(default=1.0, description="Option delta or 1.0 for shares")
    current_price: float = Field(description="Current market price in USD")
    bucket: Literal["core_engine", "core_satellite", "fomo", "defensive"] = Field(description="Portfolio strategy bucket")


class Portfolio(BaseModel):
    """Aggregate portfolio data."""

    total_equity: float = Field(description="Total portfolio equity in USD")
    positions: list[PortfolioPosition] = Field(default_factory=list, description="List of current positions")
