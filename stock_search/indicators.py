import logging
from typing import Any

import yfinance as yf

from stock_search.common_utils import MARKET_CAP_UNITS  # Re-export for backward compatibility
from stock_search.data_sources.stockanalysis import StockAnalysisSource
from stock_search.data_sources.yahoofinance import YahooFinanceSource, normalize_yahoo_ticker
from stock_search.field_definitions import INDICATOR_FIELDS

logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# --- Configuration ---
DEFAULT_RATINGS_LOOKBACK_DAYS = 90

# Re-export MARKET_CAP_UNITS for backward compatibility with existing scripts
__all__ = ["MARKET_CAP_UNITS", "StockIndicator", "parse_ratings"]

_UNSET = object()


def parse_ratings(
    ticker: str | yf.Ticker,
    days: int = DEFAULT_RATINGS_LOOKBACK_DAYS,
) -> dict[str, Any] | None:
    source = YahooFinanceSource(ticker)
    snapshot = source.get_ratings_snapshot(days=days)
    if snapshot is None:
        return None
    return {
        "median_upside_pct": snapshot.median_upside_pct,
        "ratings": snapshot.ratings,
    }


class StockIndicator:
    """Orchestrates indicator values across data sources."""

    def __init__(self, ticker: str):
        self._ticker = normalize_yahoo_ticker(ticker)
        self._yahoo = YahooFinanceSource(self._ticker)
        self._stockanalysis = StockAnalysisSource(self._ticker)
        self.ticker = self._yahoo.ticker
        self._yahoo_indicators = _UNSET
        self._stockanalysis_indicators = _UNSET

    @property
    def info(self) -> dict[str, Any]:
        """Expose Yahoo info payload for backward compatibility."""
        return self._yahoo.info

    @property
    def _yahoo_snapshot(self):
        if self._yahoo_indicators is _UNSET:
            self._yahoo_indicators = self._yahoo.get_indicators_snapshot(ratings_days=DEFAULT_RATINGS_LOOKBACK_DAYS)
        return self._yahoo_indicators

    @property
    def _stockanalysis_snapshot(self):
        if self._stockanalysis_indicators is _UNSET:
            self._stockanalysis_indicators = self._stockanalysis.get_indicators_snapshot()
        return self._stockanalysis_indicators

    def _resolve_fallback_field(self, field: str) -> float | None:
        """Resolve field value using source priority (StockAnalysis first, Yahoo fallback)."""
        # Try StockAnalysis first (primary source)
        if (value := getattr(self._stockanalysis_snapshot, field, None)) is not None:
            return value
        # Fallback to Yahoo
        return getattr(self._yahoo_snapshot, field, None)

    def _current_price_from_info(self) -> float | None:
        """Backward-compatible helper used by dashboard code."""
        return self._yahoo.get_current_price()

    @property
    def price(self) -> float | None:
        return self._yahoo_snapshot.price

    @property
    def change(self) -> float | None:
        return self._yahoo_snapshot.change

    @property
    def change_percent(self) -> float | None:
        return self._yahoo_snapshot.change_percent

    @property
    def market_cap(self) -> float | None:
        return self._resolve_fallback_field("market_cap")

    @property
    def pe(self) -> float | None:
        return self._resolve_fallback_field("pe")

    @property
    def pe_forward(self) -> float | None:
        return self._resolve_fallback_field("pe_forward")

    @property
    def peg(self) -> float | None:
        return self._resolve_fallback_field("peg")

    @property
    def beta(self) -> float | None:
        return self._resolve_fallback_field("beta")

    @property
    def revenue_growth(self) -> float | None:
        return self._resolve_fallback_field("revenue_growth")

    @property
    def gross_margin(self) -> float | None:
        return self._resolve_fallback_field("gross_margin")

    @property
    def debt_to_equity(self) -> float | None:
        return self._resolve_fallback_field("debt_to_equity")

    @property
    def free_cash_flow(self) -> float | None:
        return self._resolve_fallback_field("free_cash_flow")

    @property
    def iv(self) -> float | None:
        return self._yahoo_snapshot.iv

    @property
    def rsi(self) -> float | None:
        return self._yahoo_snapshot.rsi

    @property
    def one_month_change_percent(self) -> float | None:
        return self._yahoo_snapshot.one_month_change_percent

    @property
    def three_month_change_percent(self) -> float | None:
        return self._yahoo_snapshot.three_month_change_percent

    @property
    def six_month_change_percent(self) -> float | None:
        return self._yahoo_snapshot.six_month_change_percent

    @property
    def one_year_change_percent(self) -> float | None:
        return self._yahoo_snapshot.one_year_change_percent

    @property
    def mtd_change_percent(self) -> float | None:
        return self._yahoo_snapshot.mtd_change_percent

    @property
    def ytd_change_percent(self) -> float | None:
        return self._yahoo_snapshot.ytd_change_percent

    @property
    def ratings(self) -> list[dict[str, Any]] | None:
        return self._yahoo_snapshot.ratings

    @property
    def median_upside(self) -> float | None:
        return self._yahoo_snapshot.median_upside

    def get_all_indicators(self) -> dict[str, Any]:
        return {field: getattr(self, field) for field in INDICATOR_FIELDS}
