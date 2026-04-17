"""Shared application domain schemas reused across features and data sources."""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

from .labels import SECTOR_LABELS

# Common fields
Ticker = Annotated[str, Field(description="Ticker symbol")]
Weight = Annotated[float, Field(description="Weight as a percentage (0-100)", ge=0, le=100)]
Score = Annotated[float, Field(description="Score on a 0-10 scale", ge=0, le=10)]
Probability = Annotated[float, Field(description="Probability (0-1)", ge=0, le=1)]
Strategy = Literal["Core", "Satellite", "Speculation", "Defense"]
TickerThemeLabel = Literal["ThemePlaceholderA", "ThemePlaceholderB", "ThemePlaceholderC"]
TickerStyleLabel = Literal["StylePlaceholderA", "StylePlaceholderB", "StylePlaceholderC"]
TickerLabel = TickerThemeLabel | TickerStyleLabel


class TickerLabels(BaseModel):
    """Reusable labels payload for ticker-tagged entities."""

    labels: list[str] = Field(default_factory=list, description="Industry labels.")


def build_ticker_labels(
    theme_label: TickerThemeLabel | None = None,
    style_label: TickerStyleLabel | None = None,
) -> list[TickerLabel]:
    """Build 0, 1, or 2 labels with max one label from each set."""
    labels: list[TickerLabel] = []
    if theme_label is not None:
        labels.append(theme_label)
    if style_label is not None:
        labels.append(style_label)
    return labels


class PortfolioPositionInput(BaseModel):
    """Input portfolio position before enrichment/stat computation."""

    ticker: Ticker
    quantity: float = Field(default=0.0, description="Number of shares or contracts")


class PortfolioPositionsBase(BaseModel):
    """Base portfolio shape carrying position rows."""

    positions: list[PortfolioPositionInput] = Field(default_factory=list, description="Input positions list")


class PortfolioInput(PortfolioPositionsBase):
    """Input portfolio payload containing only ticker/quantity positions."""


class PortfolioPosition(PortfolioPositionInput):
    """Enriched portfolio position with market/context fields."""

    name: str | None = Field(default=None, description="Company name")
    price: float | None = Field(default=None, description="Current market price")
    strategy: Strategy | None = Field(default=None, description="Strategy")
    labels: list[TickerLabel] = Field(default_factory=list, description="Ticker labels for grouping and filtering.")


class PortfolioSectorDistribution(BaseModel):
    """Portfolio sector exposure split across stock and ETF lookthrough."""

    sector: str = Field(description="Sector name")
    portfolio_weight: float = Field(description="Combined portfolio sector weight (%)")
    stock_weight: float = Field(description="Direct stock sector weight (%)")
    etf_lookthrough_weight: float = Field(description="ETF lookthrough sector weight (%)")


class PortfolioStats(BaseModel):
    """Aggregate portfolio-level statistics for held positions."""

    held_positions_count: int = Field(default=0, description="Number of held positions")
    total: float = Field(default=0.0, description="Total held market value")
    change: float = Field(default=0.0, description="Portfolio daily change in value")
    change_percent: float = Field(default=0.0, description="Portfolio daily change percentage")
    weighted_beta: float | None = Field(default=None, description="Portfolio weighted beta")
    weighted_iv: float | None = Field(default=None, description="Portfolio weighted implied volatility")
    sector_distribution: list[PortfolioSectorDistribution] = Field(default_factory=list, description="Sector exposure breakdown")


class PortfolioView(PortfolioPositionsBase):
    """Aggregate enriched portfolio payload."""

    positions: list[PortfolioPosition] = Field(default_factory=list, description="Portfolio positions list")
    portfolio_stats: PortfolioStats | None = Field(default=None, description="Portfolio aggregate statistics")


class ScoredReason(BaseModel):
    """[STRUCTURED OUTPUTS] Score with supporting reason bullets."""

    score: Score
    reasons: list[str] = Field(description="Bullet list explaining the score.")


class MetricsEvaluation(BaseModel):
    """Quantitative evaluation score components."""

    market_cap_score: Score | None = Field(
        default=None,
        description="Market-cap size score (0-10) via log-S-curve mapping from 10B to 4T (median 800B).",
    )
    valuation_score: Score | None = Field(
        default=None,
        description="Valuation (1-10): PEG-first weighted mean (inverse) with PE/forward-PE/growth.",
    )
    upside_score: Score | None = Field(
        default=None,
        description="Upside (1-10): blend of analyst target upside, rating sentiment, and LLM outlook score.",
    )


class ResearchEvaluation(BaseModel):
    """[STRUCTURED OUTPUTS] LLM research scores for moat and quality."""

    moat_score: ScoredReason | None = Field(
        default=None,
        description="Moat (1-10): replaceability, switching costs, regulatory barriers, ecosystem gravity.",
    )
    quality_score: ScoredReason | None = Field(
        default=None,
        description="Quality (1-10): durability of economics, FCF margins, pricing power, resilience.",
    )


class FutureOutlook(ScoredReason):
    """[STRUCTURED OUTPUTS] LLM outlook score with bull/bear probabilities."""

    bull_probability: Probability | None = Field(default=None, description="12-month up move probability.")
    bear_probability: Probability | None = Field(default=None, description="12-month down move probability.")


class Evaluation(MetricsEvaluation, ResearchEvaluation, FutureOutlook):
    """Unified evaluation payload (scores + probabilities)."""

    flat_probability: Probability | None = Field(
        default=None,
        description="Flat probability: max(0, 1 - bull_probability - bear_probability).",
    )


class NewsAnalysis(BaseModel):
    """[STRUCTURED OUTPUTS] Structured analysis of a financial news article."""

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


class NewsMetadata(BaseModel):
    """Optional provider/debug metadata attached to a news item."""

    provider: str | None = Field(default=None, description="Provider that returned the article.")
    source_domain: str | None = Field(default=None, description="Normalized source domain.")
    published_at: str | None = Field(default=None, description="Publication timestamp in ISO 8601 format.")
    fetched_at: str | None = Field(default=None, description="Fetch timestamp in ISO 8601 format.")


class NewsArticle(NewsAnalysis):
    """News article data with attached analysis fields."""

    url: str = Field(description="Source URL")
    title: str | None = Field(default=None, description="Headline")
    date: str | None = Field(default=None, description="Publication date (YYYY-MM-DD)")
    days_ago: int | None = Field(default=None, description="Days since publication")
    metadata: NewsMetadata | None = Field(default=None, description="Optional provider/debug metadata.")


class Holding(BaseModel):
    """[STRUCTURED OUTPUTS] A single holding within an ETF."""

    ticker: Ticker
    name: str | None = Field(default=None, description="Holding name")
    weight: Weight


class ETFHoldings(BaseModel):
    """[STRUCTURED OUTPUTS] Top holdings of an ETF."""

    holdings: list[Holding] = Field(default_factory=list, description="Holdings list")


class ETFSector(BaseModel):
    """Industry sector allocation entry for an ETF."""

    name: str = Field(description="Sector name")
    weight: Weight


class ETFSectors(BaseModel):
    """[STRUCTURED OUTPUTS] Sector weights for an ETF."""

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
    """ETF metadata with holdings and sector breakdown."""

    holdings: ETFHoldings = Field(default_factory=ETFHoldings, description="Top holdings list")
    sectors: ETFSectors = Field(default_factory=ETFSectors, description="Sector allocation list")

    def sector_rows(self) -> list[ETFSector]:
        """Return sector rows sorted by weight."""
        rows: list[ETFSector] = []
        for key, value in self.sectors.model_dump().items():
            if value is None:
                continue
            rows.append(ETFSector(name=SECTOR_LABELS[key], weight=float(value)))
        rows.sort(key=lambda row: row.weight, reverse=True)
        return rows


class StockIndicators(BaseModel):
    """Unified stock indicator payload used across data sources.

    Percent-based fields in this model use percent units.
    """

    ticker: Ticker
    price: float | None = Field(default=None, description="Current price.")
    change_percent_1d: float | None = Field(default=None, description="1-day price change percent.")
    change: float | None = Field(default=None, description="Daily price change.")
    market_cap: float | None = Field(default=None, description="Market cap in dollars.")
    pe: float | None = Field(default=None, description="Trailing PE ratio.")
    pe_forward: float | None = Field(default=None, description="Forward PE ratio.")
    peg: float | None = Field(default=None, description="PEG ratio.")
    beta: float | None = Field(default=None, description="Beta.")
    iv: float | None = Field(default=None, description="Implied volatility percent.")
    change_percent_1m: float | None = Field(default=None, description="1-month price change percent.")
    change_percent_3m: float | None = Field(default=None, description="3-month price change percent.")
    change_percent_6m: float | None = Field(default=None, description="6-month price change percent.")
    change_percent_1y: float | None = Field(default=None, description="1-year price change percent.")
    change_percent_mtd: float | None = Field(default=None, description="Month-to-date price change percent.")
    change_percent_ytd: float | None = Field(default=None, description="Year-to-date price change percent.")
    median_upside: float | None = Field(default=None, description="Median analyst upside percent.")
    revenue_growth: float | None = Field(default=None, description="Revenue growth percent.")
    gross_margin: float | None = Field(default=None, description="Gross margin percent.")
    debt_to_equity: float | None = Field(default=None, description="Debt-to-equity percent.")
    free_cash_flow: float | None = Field(default=None, description="Free cash flow in dollars.")
    rsi: float | None = Field(default=None, description="Relative Strength Index (RSI).")
    ratings: list[dict[str, Any]] | None = Field(default=None, description="Analyst ratings/upgrades snapshot rows.")


class Stock(TickerLabels):
    """Top-level stock entity for storage (no quantity/news fields)."""

    ticker: Ticker
    indicators: StockIndicators | None = Field(default=None, description="Indicator snapshot payload.")
    evaluation: Evaluation | None = Field(default=None, description="Evaluation payload.")


class Portfolio(PortfolioPositionsBase):
    """Top-level portfolio entity with positions and portfolio-level statistics."""

    key: str = Field(default="default", description="Portfolio key.")
    portfolio_stats: PortfolioStats | None = Field(default=None, description="Portfolio aggregate statistics.")


class News(BaseModel):
    """Top-level news entity grouped by key."""

    key: str = Field(default="default", description="News collection key.")
    ticker: Ticker
    item: NewsArticle = Field(description="News item payload.")
