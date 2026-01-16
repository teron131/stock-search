from typing import Annotated, Literal

from pydantic import BaseModel, Field

# Common Fields
Ticker = Annotated[str, Field(description="Ticker symbol")]
Weight = Annotated[float, Field(description="Weight as a percentage (0-100)", ge=0, le=100)]
Score = Annotated[float, Field(description="Score on a 0-10 scale", ge=0, le=10)]
Probability = Annotated[float, Field(description="Probability (0-1)", ge=0, le=1)]


class Quote(BaseModel):
    """Real-time and regular market quotes."""

    ticker: Ticker
    regular_price: float | None = Field(default=None, description="Regular market price")
    regular_change: float | None = Field(default=None, description="Regular market price change")
    regular_change_percent: float | None = Field(default=None, description="Regular market price change percent")
    realtime_price: float | None = Field(default=None, description="Pre/post market price")
    realtime_change: float | None = Field(default=None, description="Pre/post market price change")
    realtime_change_percent: float | None = Field(default=None, description="Pre/post market price change percent")


class ScoredReason(BaseModel):
    score: Score
    reasons: list[str] = Field(description="Bullet list explaining the score.")


class MetricsEvaluation(BaseModel):
    market_cap: Score | None = Field(
        default=None,
        description="Market-cap size score (0-10) via log-S-curve mapping from 10B to 4T (median 800B).",
    )
    valuation: Score | None = Field(
        default=None,
        description="Valuation (1-10): PEG-first weighted mean (inverse) with PE/forward-PE/growth.",
    )
    upside: Score | None = Field(
        default=None,
        description="Upside (1-10): blend of analyst target upside, rating sentiment, and LLM outlook score.",
    )


class ResearchEvaluation(BaseModel):
    moat: ScoredReason | None = Field(
        default=None,
        description="Moat (1-10): replaceability, switching costs, regulatory barriers, ecosystem gravity.",
    )
    quality: ScoredReason | None = Field(
        default=None,
        description="Quality (1-10): durability of economics, FCF margins, pricing power, resilience.",
    )


class FutureOutlook(ScoredReason):
    bull_probability: Probability | None = Field(default=None, description="12-month up move probability.")
    bear_probability: Probability | None = Field(default=None, description="12-month down move probability.")


class Evaluation(MetricsEvaluation, ResearchEvaluation, FutureOutlook):
    flat_probability: Probability | None = Field(
        default=None,
        description="Flat probability: max(0, 1 - bull_probability - bear_probability).",
    )


class Holding(BaseModel):
    """A single holding within an ETF."""

    ticker: Ticker
    name: str | None = Field(default=None, description="Company name")
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

    summary: str = Field(default="", description="Summary excluding noise/meta-language.")
    relevancy: Literal["high", "medium", "low"] = Field(default="low", description="Article relevancy.")
    category: Literal["macro_economics", "industry_news", "market_news", "company_news", "earnings", "analyst_rating", "analysis", "other"] = Field(
        default="other", description="News category."
    )
    sentiment: Literal["bullish", "neutral", "bearish"] = Field(default="neutral", description="Market sentiment.")


class News(NewsAnalysis):
    """Full news article data including analysis results."""

    url: str = Field(description="Source URL")
    title: str | None = Field(default=None, description="Headline")
    date: str | None = Field(default=None, description="Publication date (YYYY-MM-DD)")
    days_ago: int | None = Field(default=None, description="Days since publication")


class PortfolioPosition(BaseModel):
    """A single portfolio position with notional exposure metrics."""

    ticker: Ticker
    name: str | None = Field(default=None, description="Company name")
    quantity: float | None = Field(default=None, description="Number of shares or contracts")
    delta: float | None = Field(default=None, description="Option delta (1.0 for shares)")
    current_price: float | None = Field(default=None, description="Current market price")
    bucket: Literal["Strategic Core", "Growth Satellites", "Tactical Opportunities", "Risk Mitigation"] = Field(description="Strategy bucket")


class Portfolio(BaseModel):
    """Aggregate portfolio data."""

    total_equity: float | None = Field(default=None, description="Total portfolio equity")
    positions: list[PortfolioPosition] = Field(default_factory=list, description="Portfolio positions list")
