import logging
from typing import Any

import yfinance as yf

from stock_search.data_sources.stockanalysis import StockAnalysisSource
from stock_search.data_sources.yahoofinance import YahooFinanceSource, normalize_yahoo_ticker

logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# --- Configuration ---
DEFAULT_RATINGS_LOOKBACK_DAYS = 90

# Kept as public export for scripts that format market-cap display values.
MARKET_CAP_UNITS: tuple[tuple[float, str], ...] = (
    (1_000_000_000_000, "T"),
    (1_000_000_000, "B"),
    (1_000_000, "M"),
    (1_000, "K"),
)

# --- Indicator Fields ---
_INDICATOR_FIELDS: tuple[str, ...] = (
    "price",
    "change_percent",
    "market_cap",
    "pe",
    "pe_forward",
    "peg",
    "beta",
    "iv",
    "one_month_change_percent",
    "three_month_change_percent",
    "six_month_change_percent",
    "one_year_change_percent",
    "median_upside",
    "revenue_growth",
    "gross_margin",
    "debt_to_equity",
    "free_cash_flow",
    "rsi",
    "change",
    "mtd_change_percent",
    "ytd_change_percent",
)

_UNSET = object()

_FUNDAMENTAL_FALLBACK_ORDER: tuple[str, ...] = ("yahoo", "stockanalysis")


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

    def _ordered_source_snapshots(self) -> tuple[object, ...]:
        source_snapshots = {
            "yahoo": self._yahoo_snapshot,
            "stockanalysis": self._stockanalysis_snapshot,
        }
        return tuple(source_snapshots[source_name] for source_name in _FUNDAMENTAL_FALLBACK_ORDER)

    def _resolve_fallback_field(self, field: str) -> float | None:
        for snapshot in self._ordered_source_snapshots():
            if (value := getattr(snapshot, field, None)) is not None:
                return value
        return None

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
        return {field: getattr(self, field) for field in _INDICATOR_FIELDS}
