"""ETF helper entrypoints.

Thin module that fetches ETF holdings through the StockAnalysis source adapter.
"""

from .data_sources.stockanalysis import StockAnalysisSource
from .schemas import ETFHoldings


def get_etf_data(etf_ticker: str) -> ETFHoldings:
    """Get ETF holdings for a ticker, returning an empty list on fetch failure."""
    snapshot = StockAnalysisSource(etf_ticker).get_etf_holdings_snapshot()
    return snapshot.holdings if snapshot else ETFHoldings(holdings=[])
