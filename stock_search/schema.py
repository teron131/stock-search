import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class Quote(BaseModel):
    symbol: str | None = Field(default=None, description="The symbol / ticker of the stock / ETF")
    regular_price: float | None = Field(default=None, description="The regular price")
    regular_change: float | None = Field(default=None, description="The regular change")
    regular_change_percent: float | None = Field(default=None, description="The regular change percent")
    realtime_price: float | None = Field(default=None, description="The premarket/overnight/postmarket price")
    realtime_change: float | None = Field(default=None, description="The premarket/overnight/postmarket change")
    realtime_change_percent: float | None = Field(default=None, description="The premarket/overnight/postmarket change percent")


class Holding(BaseModel):
    symbol: str = Field(default=None, description="The symbol of the holding")
    holding: str = Field(default=None, description="The name of the holding")
    weight: float = Field(default=None, description="The weight of the holding")


class Sector(BaseModel):
    sector: str = Field(default=None, description="The sector of the holding")
    weight: float = Field(default=None, description="The weight of the sector")


class ETF(BaseModel):
    top_holdings: list[Holding] = Field(default=None, description="The top holdings of the ETF")
    sectors: list[Sector] = Field(default=None, description="The sectors of the ETF")


class NewsAnalysis(BaseModel):
    """Structured analysis of a financial news article."""

    summary: str = Field(
        default="",
        description="The detailed description of the news including mentioned facts and excluding the garbage content and advertisements. Do not use meta languages such as 'The news / article / search result is about / mentioned / discussed...'",
    )
    tickers: list[str] = Field(
        default_factory=list,
        description="Stock tickers mentioned in the article (e.g., ['NVDA', 'AAPL']).",
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
        description="Market sentiment specifically for the primary subject.",
    )

    @field_validator("tickers")
    @classmethod
    def validate_tickers(cls, v: list[str]) -> list[str]:
        ticker_pattern = re.compile(r"^[A-Z]{1,5}$")
        return [ticker for ticker in v if ticker_pattern.match(ticker)]


class News(NewsAnalysis):
    title: str = Field(default=None, description="The title of the news")
    url: str = Field(default=None, description="The URL of the news")
    date: str = Field(default=None, description="The date of the news")
    relevance: Literal[
        "strong",
        "weak",
        "irrelevant",
    ] = Field(
        default="irrelevant",
        description="Relevance of the news based on the number of tickers mentioned.",
    )


class PortfolioPosition(BaseModel):
    """A single position with notional exposure."""

    ticker: str = Field(description="Stock ticker symbol")
    quantity: float = Field(description="Number of shares or contracts")
    delta: float = Field(default=1.0, description="Delta (1.0 for shares, 0-1 for options)")
    current_price: float = Field(description="Current price in USD")
    bucket: Literal["core_engine", "core_satellite", "fomo", "defensive"] = Field(description="Bucket: core_engine, core_satellite, fomo, or defensive")


class Portfolio(BaseModel):
    """Portfolio with notional exposures."""

    total_equity: float = Field(description="Total equity in USD")
    positions: list[PortfolioPosition] = Field(description="Portfolio positions")
