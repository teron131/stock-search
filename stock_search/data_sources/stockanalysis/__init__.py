"""StockAnalysis source adapter package."""

from .adapter import (
    StockAnalysisSource,
    get_industry_snapshot,
    get_industry_snapshot_async,
)
from .schemas import (
    StockAnalysisEtfSnapshot,
    StockAnalysisFinancials,
    StockAnalysisIndicatorsSnapshot,
    StockAnalysisIndustrySnapshot,
    StockAnalysisIndustrySummary,
    StockAnalysisStatistics,
)

__all__ = [
    "StockAnalysisEtfSnapshot",
    "StockAnalysisFinancials",
    "StockAnalysisIndicatorsSnapshot",
    "StockAnalysisIndustrySnapshot",
    "StockAnalysisIndustrySummary",
    "StockAnalysisSource",
    "StockAnalysisStatistics",
    "get_industry_snapshot",
    "get_industry_snapshot_async",
]
