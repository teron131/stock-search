from datetime import UTC, datetime, timedelta
import logging
from typing import Any

import yfinance as yf

from stock_search.config import CacheConfig
from stock_search.data_sources.stockanalysis import StockAnalysisSource
from stock_search.data_sources.yahoofinance import YahooFinanceSource, normalize_yahoo_ticker
from stock_search.field_definitions import INDICATOR_FIELDS
from stock_search.schemas import Stock

logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# --- Configuration ---
DEFAULT_RATINGS_LOOKBACK_DAYS = 90
DEFAULT_FUNDAMENTALS_CACHE_MAX_AGE = timedelta(seconds=CacheConfig.INFO_STALE_SECONDS)
FUNDAMENTALS_FETCHED_AT_FIELD = "fundamentals_fetched_at"
DATA_SOURCE_YAHOOFINANCE = "YAHOOFINANCE"
DATA_SOURCE_STOCKANALYSIS_STATISTICS = "STOCKANALYSIS_STATISTICS"
DATA_SOURCE_STOCKANALYSIS_FINANCIALS = "STOCKANALYSIS_FINANCIALS"
DATA_SOURCE_STOCKANALYSIS_ETF_HOLDINGS = "STOCKANALYSIS_ETF_HOLDINGS"
FUNDAMENTALS_CACHE_MAX_AGE_BY_FIELD: dict[str, timedelta] = {
    "market_cap": timedelta(days=3),
    "pe": timedelta(days=3),
    "pe_forward": timedelta(days=3),
    "peg": timedelta(days=7),
    "beta": timedelta(days=7),
    "revenue_growth": timedelta(days=7),
    "gross_margin": timedelta(days=7),
    "debt_to_equity": timedelta(days=7),
    "free_cash_flow": timedelta(days=7),
    "median_upside": timedelta(days=7),
    "ratings": timedelta(days=7),
}
INDICATOR_FIELDS_BY_SOURCE: dict[str, tuple[str, ...]] = {
    DATA_SOURCE_YAHOOFINANCE: (
        "price",
        "change",
        "change_percent",
        "iv",
        "rsi",
        "one_month_change_percent",
        "three_month_change_percent",
        "six_month_change_percent",
        "one_year_change_percent",
        "mtd_change_percent",
        "ytd_change_percent",
        "ratings",
        "median_upside",
    ),
    DATA_SOURCE_STOCKANALYSIS_STATISTICS: (
        "market_cap",
        "pe",
        "pe_forward",
        "peg",
        "beta",
        "free_cash_flow",
    ),
    DATA_SOURCE_STOCKANALYSIS_FINANCIALS: (
        "revenue_growth",
        "gross_margin",
        "debt_to_equity",
    ),
    DATA_SOURCE_STOCKANALYSIS_ETF_HOLDINGS: (),
}
_FIELD_SOURCE_GROUP: dict[str, str] = {field: source for source, fields in INDICATOR_FIELDS_BY_SOURCE.items() for field in fields}
_SOURCE_PRIORITY_BY_GROUP: dict[str, tuple[str, ...]] = {
    DATA_SOURCE_YAHOOFINANCE: ("yahoo", "cache"),
    DATA_SOURCE_STOCKANALYSIS_STATISTICS: ("stockanalysis", "cache", "yahoo"),
    DATA_SOURCE_STOCKANALYSIS_FINANCIALS: ("stockanalysis", "cache", "yahoo"),
    DATA_SOURCE_STOCKANALYSIS_ETF_HOLDINGS: ("cache",),
}

__all__ = ["StockIndicator", "parse_ratings"]

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

    def __init__(
        self,
        ticker: str,
        *,
        cached_row: dict[str, Any] | None = None,
        now: datetime | None = None,
        fundamentals_cache_max_age: timedelta = DEFAULT_FUNDAMENTALS_CACHE_MAX_AGE,
        fundamentals_cache_max_age_by_field: dict[str, timedelta] | None = None,
    ):
        self._ticker = normalize_yahoo_ticker(ticker)
        self._yahoo = YahooFinanceSource(self._ticker)
        self._stockanalysis = StockAnalysisSource(self._ticker)
        self.ticker = self._yahoo.ticker
        self._cached_row = dict(cached_row) if isinstance(cached_row, dict) else {}
        self._now = now or datetime.now(tz=UTC)
        self._fundamentals_cache_max_age = fundamentals_cache_max_age
        self._fundamentals_cache_max_age_by_field = {
            **FUNDAMENTALS_CACHE_MAX_AGE_BY_FIELD,
            **(fundamentals_cache_max_age_by_field or {}),
        }
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

    @staticmethod
    def _parse_iso(value: Any) -> datetime | None:
        if not isinstance(value, str) or not value.strip():
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
        except ValueError:
            return None

    def _cache_max_age_for_field(self, field: str) -> timedelta:
        return self._fundamentals_cache_max_age_by_field.get(field, self._fundamentals_cache_max_age)

    def _has_fresh_fundamentals_cache(self, field: str) -> bool:
        fetched_at = self._parse_iso(self._cached_row.get(FUNDAMENTALS_FETCHED_AT_FIELD))
        if fetched_at is None:
            return False
        return self._now - fetched_at <= self._cache_max_age_for_field(field)

    def _cached_value(self, field: str) -> Any:
        if not self._has_fresh_fundamentals_cache(field):
            return None
        return self._cached_row.get(field)

    def _resolve_field(self, field: str, *, sources: tuple[str, ...]) -> Any:
        for source in sources:
            if source == "stockanalysis":
                value = getattr(self._stockanalysis_snapshot, field, None)
            elif source == "yahoo":
                value = getattr(self._yahoo_snapshot, field, None)
            elif source == "cache":
                value = self._cached_value(field)
            else:
                continue
            if value is not None:
                return value
        return None

    def _source_group_for_field(self, field: str) -> str:
        return _FIELD_SOURCE_GROUP.get(field, DATA_SOURCE_YAHOOFINANCE)

    @staticmethod
    def field_source_map() -> dict[str, str]:
        """Return indicator field -> logical source-group mapping."""
        return {field: _FIELD_SOURCE_GROUP.get(field, DATA_SOURCE_YAHOOFINANCE) for field in INDICATOR_FIELDS}

    def _resolve_indicator_field(self, field: str) -> Any:
        source_group = self._source_group_for_field(field)
        sources = _SOURCE_PRIORITY_BY_GROUP.get(source_group, ("yahoo", "cache"))
        return self._resolve_field(field, sources=sources)

    @property
    def price(self) -> float | None:
        return self._resolve_indicator_field("price")

    @property
    def change(self) -> float | None:
        return self._resolve_indicator_field("change")

    @property
    def change_percent(self) -> float | None:
        return self._resolve_indicator_field("change_percent")

    @property
    def market_cap(self) -> float | None:
        return self._resolve_indicator_field("market_cap")

    @property
    def pe(self) -> float | None:
        return self._resolve_indicator_field("pe")

    @property
    def pe_forward(self) -> float | None:
        return self._resolve_indicator_field("pe_forward")

    @property
    def peg(self) -> float | None:
        return self._resolve_indicator_field("peg")

    @property
    def beta(self) -> float | None:
        return self._resolve_indicator_field("beta")

    @property
    def revenue_growth(self) -> float | None:
        return self._resolve_indicator_field("revenue_growth")

    @property
    def gross_margin(self) -> float | None:
        return self._resolve_indicator_field("gross_margin")

    @property
    def debt_to_equity(self) -> float | None:
        return self._resolve_indicator_field("debt_to_equity")

    @property
    def free_cash_flow(self) -> float | None:
        return self._resolve_indicator_field("free_cash_flow")

    @property
    def iv(self) -> float | None:
        return self._resolve_indicator_field("iv")

    @property
    def rsi(self) -> float | None:
        return self._resolve_indicator_field("rsi")

    @property
    def one_month_change_percent(self) -> float | None:
        return self._resolve_indicator_field("one_month_change_percent")

    @property
    def three_month_change_percent(self) -> float | None:
        return self._resolve_indicator_field("three_month_change_percent")

    @property
    def six_month_change_percent(self) -> float | None:
        return self._resolve_indicator_field("six_month_change_percent")

    @property
    def one_year_change_percent(self) -> float | None:
        return self._resolve_indicator_field("one_year_change_percent")

    @property
    def mtd_change_percent(self) -> float | None:
        return self._resolve_indicator_field("mtd_change_percent")

    @property
    def ytd_change_percent(self) -> float | None:
        return self._resolve_indicator_field("ytd_change_percent")

    @property
    def ratings(self) -> list[dict[str, Any]] | None:
        return self._resolve_indicator_field("ratings")

    @property
    def median_upside(self) -> float | None:
        return self._resolve_indicator_field("median_upside")

    def to_stock(self) -> Stock:
        """Build a typed stock payload from resolved indicator values."""
        payload: dict[str, Any] = {"ticker": self._ticker}
        payload.update({field: getattr(self, field) for field in INDICATOR_FIELDS})
        return Stock.model_validate(payload)

    def get_all_indicators(self) -> dict[str, Any]:
        return self.to_stock().model_dump()
