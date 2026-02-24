from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, create_model

from stock_search.field_definitions import INDICATOR_FIELD_DEFINITIONS

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

INDUSTRY_LABELS: tuple[str, ...] = (
    "Biotechnology",
    "Medical Devices",
    "Drug Manufacturers - Specialty & Generic",
    "Medical Instruments & Supplies",
    "Medical Care Facilities",
    "Diagnostics & Research",
    "Health Information Services",
    "Drug Manufacturers - General",
    "Medical Distribution",
    "Healthcare Plans",
    "Pharmaceutical Retailers",
    "Banks - Regional",
    "Shell Companies",
    "Asset Management",
    "Capital Markets",
    "Credit Services",
    "Insurance - Property & Casualty",
    "Insurance Brokers",
    "Insurance - Life",
    "Banks - Diversified",
    "Insurance - Specialty",
    "Financial Data & Stock Exchanges",
    "Mortgage Finance",
    "Insurance - Diversified",
    "Insurance - Reinsurance",
    "Financial Conglomerates",
    "Software - Application",
    "Software - Infrastructure",
    "Information Technology Services",
    "Semiconductors",
    "Electronic Components",
    "Communication Equipment",
    "Computer Hardware",
    "Scientific & Technical Instruments",
    "Semiconductor Equipment & Materials",
    "Solar",
    "Consumer Electronics",
    "Electronics & Computer Distribution",
    "Aerospace & Defense",
    "Specialty Industrial Machinery",
    "Engineering & Construction",
    "Electrical Equipment & Parts",
    "Specialty Business Services",
    "Marine Shipping",
    "Building Products & Equipment",
    "Integrated Freight & Logistics",
    "Farm & Heavy Construction Machinery",
    "Conglomerates",
    "Consulting Services",
    "Industrial Distribution",
    "Security & Protection Services",
    "Rental & Leasing Services",
    "Waste Management",
    "Airlines",
    "Staffing & Employment Services",
    "Pollution & Treatment Controls",
    "Metal Fabrication",
    "Trucking",
    "Railroads",
    "Tools & Accessories",
    "Airports & Air Services",
    "Business Equipment & Supplies",
    "Infrastructure Operations",
    "Oil & Gas Exploration & Production",
    "Oil & Gas Midstream",
    "Oil & Gas Equipment & Services",
    "Oil & Gas Refining & Marketing",
    "Oil & Gas Integrated",
    "Uranium",
    "Oil & Gas Drilling",
    "Thermal Coal",
    "Internet Content & Information",
    "Telecom Services",
    "Entertainment",
    "Advertising Agencies",
    "Electronic Gaming & Multimedia",
    "Broadcasting",
    "Publishing",
    "Packaged Foods",
    "Education & Training Services",
    "Household & Personal Products",
    "Farm Products",
    "Beverages - Non-Alcoholic",
    "Food Distribution",
    "Grocery Stores",
    "Tobacco",
    "Beverages - Wineries & Distilleries",
    "Discount Stores",
    "Beverages - Brewers",
    "Confectioners",
    "Specialty Chemicals",
    "Gold",
    "Other Industrial Metals & Mining",
    "Steel",
    "Chemicals",
    "Building Materials",
    "Other Precious Metals & Mining",
    "Agricultural Inputs",
    "Coking Coal",
    "Lumber & Wood Production",
    "Copper",
    "Silver",
    "Paper & Paper Products",
    "Aluminum",
    "Auto Parts",
    "Restaurants",
    "Specialty Retail",
    "Internet Retail",
    "Furnishings, Fixtures & Appliances",
    "Leisure",
    "Apparel Retail",
    "Auto Manufacturers",
    "Auto & Truck Dealerships",
    "Packaging & Containers",
    "Apparel Manufacturing",
    "Residential Construction",
    "Travel Services",
    "Resorts & Casinos",
    "Recreational Vehicles",
    "Footwear & Accessories",
    "Personal Services",
    "Gambling",
    "Lodging",
    "Luxury Goods",
    "Home Improvement Retail",
    "Textile Manufacturing",
    "Department Stores",
    "Real Estate Services",
    "REIT - Mortgage",
    "REIT - Retail",
    "REIT - Residential",
    "REIT - Office",
    "REIT - Healthcare Facilities",
    "REIT - Specialty",
    "REIT - Industrial",
    "REIT - Diversified",
    "Real Estate - Development",
    "REIT - Hotel & Motel",
    "Real Estate - Diversified",
    "Utilities - Regulated Electric",
    "Utilities - Renewable",
    "Utilities - Regulated Gas",
    "Utilities - Regulated Water",
    "Utilities - Independent Power Producers",
    "Utilities - Diversified",
)

# Common Fields
Ticker = Annotated[str, Field(description="Ticker symbol")]
Weight = Annotated[float, Field(description="Weight as a percentage (0-100)", ge=0, le=100)]
Score = Annotated[float, Field(description="Score on a 0-10 scale", ge=0, le=10)]
Probability = Annotated[float, Field(description="Probability (0-1)", ge=0, le=1)]
Strategy = Literal["Core", "Satellite", "Speculation", "Defense"]
TickerThemeLabel = Literal["ThemePlaceholderA", "ThemePlaceholderB", "ThemePlaceholderC"]
TickerStyleLabel = Literal["StylePlaceholderA", "StylePlaceholderB", "StylePlaceholderC"]
TickerLabel = TickerThemeLabel | TickerStyleLabel


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


class PortfolioInput(BaseModel):
    """Input portfolio payload containing only ticker/quantity positions."""

    positions: list[PortfolioPositionInput] = Field(default_factory=list, description="Input positions list")


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


class Portfolio(BaseModel):
    """Aggregate enriched portfolio payload."""

    positions: list[PortfolioPosition] = Field(default_factory=list, description="Portfolio positions list")
    portfolio_stats: PortfolioStats | None = Field(default=None, description="Portfolio aggregate statistics")


_STOCK_FIELD_OVERRIDES: dict[str, tuple[Any, Any]] = {
    "ratings": (
        list[dict[str, Any]] | None,
        Field(default=None, description="Analyst ratings/upgrades snapshot rows."),
    ),
}

_stock_fields: dict[str, tuple[Any, Any]] = {
    "ticker": (Ticker, Field(description="Ticker symbol")),
}
for field_definition in INDICATOR_FIELD_DEFINITIONS:
    field_name = field_definition.name
    if field_name in _STOCK_FIELD_OVERRIDES:
        _stock_fields[field_name] = _STOCK_FIELD_OVERRIDES[field_name]
        continue
    _stock_fields[field_name] = (
        float | None,
        Field(default=None, description=f"{field_name.replace('_', ' ').title()}."),
    )

Stock = create_model("Stock", __base__=BaseModel, **_stock_fields)
Stock.__doc__ = "Unified stock indicator payload used across data sources."


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
        rows: list[ETFSector] = []
        for key, value in self.sectors.model_dump().items():
            if value is None:
                continue
            rows.append(ETFSector(name=SECTOR_LABELS[key], weight=float(value)))
        rows.sort(key=lambda row: row.weight, reverse=True)
        return rows


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


class News(NewsAnalysis):
    """News article data with attached analysis fields."""

    url: str = Field(description="Source URL")
    title: str | None = Field(default=None, description="Headline")
    date: str | None = Field(default=None, description="Publication date (YYYY-MM-DD)")
    days_ago: int | None = Field(default=None, description="Days since publication")


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
