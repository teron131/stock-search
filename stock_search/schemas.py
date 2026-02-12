from typing import Annotated, Literal

from pydantic import BaseModel, Field

SECTOR_LABELS: dict[str, str] = {
    "communication_services": "Communication Services",
    "consumer_discretionary": "Consumer Discretionary",
    "consumer_staples": "Consumer Staples",
    "energy": "Energy",
    "financials": "Financials",
    "health_care": "Health Care",
    "industrials": "Industrials",
    "materials": "Materials",
    "real_estate": "Real Estate",
    "technology": "Technology",
    "utilities": "Utilities",
    "other": "Other",
}
SECTOR_LABEL_TO_KEY: dict[str, str] = {label: key for key, label in SECTOR_LABELS.items()}
SECTOR_PATTERN_RULES: tuple[tuple[str, str], ...] = (
    (r"\bcommunication\b|\btelecom", "Communication Services"),
    (r"\bconsumer\b.*\b(cyclical|discretionary)\b|\bdiscretionary\b", "Consumer Discretionary"),
    (r"\bconsumer\b.*\b(defensive|staples)\b|\bstaples\b", "Consumer Staples"),
    (r"\benergy\b|oil|gas", "Energy"),
    (r"\bfinancial\b|financial services|bank|insurance|capital market|asset management", "Financials"),
    (r"\bhealth\s*care\b|\bhealthcare\b|biotech|pharma|medical", "Health Care"),
    (r"\bindustrial", "Industrials"),
    (r"\bmaterial\b|basic materials|chemicals|mining", "Materials"),
    (r"real estate|reit", "Real Estate"),
    (r"\btech\b|technology|software|semiconductor|information technology", "Technology"),
    (r"\butilities?\b", "Utilities"),
)

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
    """A single holding within an ETF. Used for structured outputs."""

    ticker: Ticker
    name: str | None = Field(default=None, description="Holding name")
    weight: Weight


class ETFSector(BaseModel):
    """Industry sector allocation entry for an ETF. Used for structured outputs."""

    name: str = Field(description="Sector name")
    weight: Weight


class ETFHoldings(BaseModel):
    """Top holdings of an ETF. Used for structured outputs."""

    holdings: list[Holding] = Field(default_factory=list, description="Holdings list")


class ETFSectors(BaseModel):
    """Sectors of an ETF. Used for structured outputs."""

    communication_services: Weight | None = Field(default=None, description="Communication Services sector weight")
    consumer_discretionary: Weight | None = Field(default=None, description="Consumer Discretionary sector weight")
    consumer_staples: Weight | None = Field(default=None, description="Consumer Staples sector weight")
    energy: Weight | None = Field(default=None, description="Energy sector weight")
    financials: Weight | None = Field(default=None, description="Financials sector weight")
    health_care: Weight | None = Field(default=None, description="Health Care sector weight")
    industrials: Weight | None = Field(default=None, description="Industrials sector weight")
    materials: Weight | None = Field(default=None, description="Materials sector weight")
    real_estate: Weight | None = Field(default=None, description="Real Estate sector weight")
    technology: Weight | None = Field(default=None, description="Technology sector weight")
    utilities: Weight | None = Field(default=None, description="Utilities sector weight")
    other: Weight | None = Field(default=None, description="Other sector weight")


class ETF(BaseModel):
    """ETF-specific metadata including holdings and sector breakdown."""

    holdings: ETFHoldings = Field(default_factory=ETFHoldings, description="Top holdings list")
    sectors: ETFSectors = Field(default_factory=ETFSectors, description="Sector allocation list")

    def sector_rows(self) -> list[ETFSector]:
        rows: list[ETFSector] = []
        for key, value in self.sectors.model_dump().items():
            if value is None:
                continue
            rows.append(ETFSector(name=SECTOR_LABELS[key], weight=float(value)))
        rows.sort(key=lambda row: row.weight, reverse=True)
        return rows


class NewsAnalysis(BaseModel):
    """Structured analysis of a financial news article."""

    summary: str = Field(default="", description="Summary excluding noise/meta-language.")
    relevancy: Literal["high", "medium", "low"] = Field(default="low", description="Article relevancy.")
    category: Literal[
        "macro_economics",
        "industry_news",
        "market_news",
        "company_news",
        "earnings",
        "analyst_rating",
        "analysis",
        "other",
    ] = Field(default="other", description="News category.")
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
    delta: float | None = Field(
        default=None,
        description="Net option delta overlay (defaults to 0.0); each 1.0 adds 100 share-equivalents",
    )
    current_price: float | None = Field(default=None, description="Current market price")
    bucket: (
        Literal[
            "Strategic Core",
            "Growth Satellites",
            "Tactical Opportunities",
            "Risk Mitigation",
        ]
        | None
    ) = Field(default=None, description="Strategy bucket")


class Portfolio(BaseModel):
    """Aggregate portfolio data."""

    total_equity: float | None = Field(default=None, description="Total portfolio equity")
    positions: list[PortfolioPosition] = Field(default_factory=list, description="Portfolio positions list")
