import calendar
from contextlib import suppress
from datetime import date, datetime, time
import logging
import math
from typing import Any, cast
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

from stock_search.data_sources.stockanalysis import StockAnalysisSource
from stock_search.data_sources.yahoofinance import YahooFinanceSource, normalize_yahoo_ticker

logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# --- Configuration ---
DEFAULT_RATINGS_LOOKBACK_DAYS = 90
DEFAULT_RSI_PERIOD = 14

# Kept as public export for scripts that format market-cap display values.
MARKET_CAP_UNITS: tuple[tuple[float, str], ...] = (
    (1_000_000_000_000, "T"),
    (1_000_000_000, "B"),
    (1_000_000, "M"),
    (1_000, "K"),
)

# --- Market Session Constants ---
MARKET_STATE_PRE = "PRE"
MARKET_STATE_REGULAR = "REGULAR"
MARKET_STATE_POST = "POST"
MARKET_STATE_POSTPOST = "POSTPOST"
MARKET_STATE_CLOSED = "CLOSED"

NY_TZ = ZoneInfo("America/New_York")
_SESSION_PRE_START = time(4, 0)
_SESSION_REGULAR_START = time(9, 30)
_SESSION_REGULAR_END = time(16, 0)
_SESSION_POST_END = time(20, 0)

_SESSION_WINDOWS: dict[str, tuple[time, time]] = {
    MARKET_STATE_PRE: (_SESSION_PRE_START, _SESSION_REGULAR_START),
    MARKET_STATE_REGULAR: (_SESSION_REGULAR_START, _SESSION_REGULAR_END),
    MARKET_STATE_POST: (_SESSION_REGULAR_END, _SESSION_POST_END),
    MARKET_STATE_POSTPOST: (_SESSION_REGULAR_END, _SESSION_POST_END),
}

# --- History & Volatility ---
_INTRADAY_INTERVALS = ("1m", "5m", "15m")
_DAILY_HISTORY_PERIOD = "5d"
_DAILY_INTERVAL = "1d"

_HV_WINDOWS_TO_WEIGHTS: tuple[tuple[int, int], ...] = (
    (180, 5),
    (90, 4),
    (30, 3),
    (7, 2),
    (1, 1),
)

# --- Period Return Configuration ---
_PERIOD_CONFIGS: dict[str, tuple[int, str]] = {
    "one_month": (1, "2y"),
    "three_month": (3, "2y"),
    "six_month": (6, "2y"),
    "one_year": (12, "3y"),
}

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


# --- Helper Functions ---


def _round(value: float | None, decimals: int = 2) -> float | None:
    """Round a value if not None."""
    return round(float(value), decimals) if value is not None else None


def _safe_float(value: Any) -> float | None:
    """Convert value to float when possible."""
    with suppress(TypeError, ValueError):
        converted = float(value)
        return converted if math.isfinite(converted) else None
    return None


def _subtract_months(value: date, months: int) -> date:
    """Return a date shifted back by N calendar months."""
    year, month = value.year, value.month - months
    while month <= 0:
        month += 12
        year -= 1
    return date(year, month, min(value.day, calendar.monthrange(year, month)[1]))


def _close_series(hist: pd.DataFrame) -> pd.Series | None:
    """Get non-empty Close series from a history frame, or None."""
    if hist.empty or "Close" not in hist:
        return None
    series = hist["Close"].dropna()
    return series if not series.empty else None


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
    """Fetches and calculates technical and fundamental indicators for a stock."""

    def __init__(self, ticker: str):
        self._ticker = normalize_yahoo_ticker(ticker)
        self._yahoo = YahooFinanceSource(self._ticker)
        self._stockanalysis = StockAnalysisSource(self._ticker)
        self.ticker = self._yahoo.ticker
        self._parsed_ratings: dict[str, Any] | None | object = _UNSET
        self._iv_percent: float | None | object = _UNSET

    # -------------------------------------------------------------------------
    # Time Utilities
    # -------------------------------------------------------------------------

    @staticmethod
    def _now_ny() -> datetime:
        """Get current time in New York timezone."""
        return datetime.now(tz=NY_TZ)

    @staticmethod
    def _infer_session(now_ny: datetime) -> str:
        """Infer market session from New York time."""
        if now_ny.weekday() >= 5:
            return MARKET_STATE_CLOSED
        now_time = now_ny.timetz().replace(tzinfo=None)
        if _SESSION_PRE_START <= now_time < _SESSION_REGULAR_START:
            return MARKET_STATE_PRE
        if _SESSION_REGULAR_START <= now_time < _SESSION_REGULAR_END:
            return MARKET_STATE_REGULAR
        if _SESSION_REGULAR_END <= now_time < _SESSION_POST_END:
            return MARKET_STATE_POST
        return MARKET_STATE_CLOSED

    @staticmethod
    def _session_window(now_ny: datetime, session: str) -> tuple[datetime, datetime] | None:
        """Get session start/end datetimes for the given session."""
        if session not in _SESSION_WINDOWS:
            return None
        start_t, end_t = _SESSION_WINDOWS[session]
        d = now_ny.date()
        return datetime.combine(d, start_t, tzinfo=NY_TZ), datetime.combine(d, end_t, tzinfo=NY_TZ)

    @staticmethod
    def _index_to_ny(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
        """Convert pandas DatetimeIndex to New York timezone."""
        return index.tz_convert(NY_TZ) if index.tz else index.tz_localize(NY_TZ)

    # -------------------------------------------------------------------------
    # Data Fetching
    # -------------------------------------------------------------------------

    def _history(
        self,
        *,
        period: str,
        interval: str | None = None,
        prepost: bool = False,
    ) -> pd.DataFrame:
        """Fetch historical price data from Yahoo source."""
        return self._yahoo.get_history_snapshot(
            period=period,
            interval=interval,
            prepost=prepost,
        ).history

    @property
    def info(self) -> dict[str, Any]:
        """Get provider-ready Yahoo info payload."""
        return self._yahoo.get_info_snapshot().raw_info

    @property
    def _stockanalysis_stats(self):
        return self._stockanalysis.get_statistics_snapshot()

    def _resolve_fallback(self, *, yahoo_value: float | None, stockanalysis_value: float | None) -> float | None:
        """Resolve indicator field value from source precedence."""
        values = {
            "yahoo": yahoo_value,
            "stockanalysis": stockanalysis_value,
        }
        for source_name in _FUNDAMENTAL_FALLBACK_ORDER:
            if (value := values[source_name]) is not None:
                return value
        return None

    @property
    def _market_state(self) -> str:
        """Get current market state from Yahoo info."""
        return self._yahoo.get_market_state()

    # -------------------------------------------------------------------------
    # Price Resolution
    # -------------------------------------------------------------------------

    def _extract_session_close(
        self,
        hist: pd.DataFrame,
        window: tuple[datetime, datetime] | None,
    ) -> float | None:
        """Extract the last close price from history, optionally scoped to a session window."""
        series = _close_series(hist)
        if series is None:
            return None
        try:
            if window:
                index_ny = self._index_to_ny(hist.index)
                scoped = hist.loc[(index_ny >= window[0]) & (index_ny < window[1])]
                scoped_series = _close_series(scoped)
                if scoped_series is not None:
                    return _round(float(scoped_series.iloc[-1]))
            return _round(float(series.iloc[-1]))
        except Exception:
            return None

    def _last_intraday_price(self) -> float | None:
        """Best-effort intraday close price (fallback when `info` is missing)."""
        now_ny = self._now_ny()
        session = self._market_state or self._infer_session(now_ny)
        window = self._session_window(now_ny, session)
        for interval in _INTRADAY_INTERVALS:
            hist = self._history(period="1d", interval=interval, prepost=True)
            if (price := self._extract_session_close(hist, window)) is not None:
                return price
        return None

    def _daily_close_series(self) -> pd.Series | None:
        """Get daily close series from recent history."""
        return _close_series(self._history(period=_DAILY_HISTORY_PERIOD, interval=_DAILY_INTERVAL))

    def _last_close(self) -> float | None:
        """Best-effort daily close price."""
        series = self._daily_close_series()
        if series is None:
            return None
        with suppress(Exception):
            return _round(float(series.iloc[-1]))
        return None

    def _previous_close_from_history(self) -> float | None:
        """Best-effort previous close from daily history."""
        series = self._daily_close_series()
        if series is None:
            return None
        with suppress(Exception):
            idx = -2 if len(series) >= 2 else -1
            return _round(float(series.iloc[idx]))
        return None

    def _select_realtime_price_from_info(self) -> float | None:
        """Pick the best available price from Yahoo `info`, including pre/post market."""
        return self._yahoo.get_realtime_price(self._market_state)

    @property
    def price(self) -> float | None:
        """Get latest price based on market state (Pre, Regular, Post)."""
        return self._select_realtime_price_from_info() or _round(self._yahoo.get_current_price()) or self._last_intraday_price() or self._last_close()

    def _get_previous_close(self) -> float | None:
        """Get appropriate baseline price for calculating change."""
        if (prev := self._yahoo.get_previous_close()) is not None:
            return _round(prev)
        return self._previous_close_from_history()

    def _price_and_previous_close(self) -> tuple[float, float] | None:
        """Resolve both current and previous close once for change metrics."""
        current, previous = self.price, self._get_previous_close()
        return (current, previous) if current is not None and previous is not None else None

    # -------------------------------------------------------------------------
    # Change Calculations
    # -------------------------------------------------------------------------

    @property
    def change(self) -> float | None:
        """Calculate change from previous close."""
        pair = self._price_and_previous_close()
        return _round(pair[0] - pair[1]) if pair else None

    @property
    def change_percent(self) -> float | None:
        """Calculate percentage change from previous close."""
        pair = self._price_and_previous_close()
        if pair is None or pair[1] == 0:
            return None
        return _round(((pair[0] - pair[1]) / pair[1]) * 100)

    # -------------------------------------------------------------------------
    # Fundamental Indicators
    # -------------------------------------------------------------------------

    @property
    def market_cap(self) -> float | None:
        """Raw market cap in dollars."""
        yahoo_value = self._yahoo.get_market_cap()
        stockanalysis_value = _safe_float(self._stockanalysis_stats.market_cap)
        return self._resolve_fallback(yahoo_value=yahoo_value, stockanalysis_value=stockanalysis_value)

    @property
    def pe(self) -> float | None:
        """Trailing P/E ratio."""
        yahoo_value = self._yahoo.get_pe_trailing()
        stockanalysis_value = _round(_safe_float(self._stockanalysis_stats.trailing_pe))
        return self._resolve_fallback(yahoo_value=yahoo_value, stockanalysis_value=stockanalysis_value)

    @property
    def pe_forward(self) -> float | None:
        """Forward P/E via fiscal-year-weighted NTM EPS (FY0 -> FY1), with FY1 fallback.

        Different platforms label "forward P/E" differently (FY0, FY1, or NTM).
        To reduce cross-platform drift, we blend EPS This Year (FY0) and EPS Next
        Year (FY1) using days-to-fiscal-year-end, so the denominator shifts
        naturally through the year from FY0 toward FY1.
        """
        yahoo_value = self._yahoo.get_forward_pe_ntm()
        stockanalysis_value = _round(_safe_float(self._stockanalysis_stats.forward_pe))
        return self._resolve_fallback(yahoo_value=yahoo_value, stockanalysis_value=stockanalysis_value)

    @property
    def peg(self) -> float | None:
        """PEG ratio."""
        yahoo_value = self._yahoo.get_peg()
        stockanalysis_value = _round(_safe_float(self._stockanalysis_stats.peg_ratio))
        return self._resolve_fallback(yahoo_value=yahoo_value, stockanalysis_value=stockanalysis_value)

    @property
    def beta(self) -> float | None:
        """Beta from Yahoo fundamentals."""
        yahoo_value = self._yahoo.get_beta()
        stockanalysis_value = _round(_safe_float(self._stockanalysis_stats.beta_5y))
        return self._resolve_fallback(yahoo_value=yahoo_value, stockanalysis_value=stockanalysis_value)

    @property
    def revenue_growth(self) -> float | None:
        """Revenue growth percentage."""
        return self._yahoo.get_revenue_growth_percent()

    @property
    def gross_margin(self) -> float | None:
        """Gross margin percentage."""
        yahoo_value = self._yahoo.get_gross_margin_percent()
        stockanalysis_ratio = _safe_float(self._stockanalysis_stats.gross_margin)
        stockanalysis_value = _round(stockanalysis_ratio * 100) if stockanalysis_ratio is not None else None
        return self._resolve_fallback(yahoo_value=yahoo_value, stockanalysis_value=stockanalysis_value)

    @property
    def debt_to_equity(self) -> float | None:
        """Debt-to-equity percentage from Yahoo Finance."""
        yahoo_value = self._yahoo.get_debt_to_equity_percent()
        stockanalysis_ratio = _safe_float(self._stockanalysis_stats.debt_to_equity)
        stockanalysis_value = _round(stockanalysis_ratio * 100) if stockanalysis_ratio is not None else None
        return self._resolve_fallback(yahoo_value=yahoo_value, stockanalysis_value=stockanalysis_value)

    @property
    def free_cash_flow(self) -> float | None:
        """Free cash flow converted to the quote currency when needed."""
        return self._yahoo.get_free_cash_flow_in_quote_currency()

    # -------------------------------------------------------------------------
    # Volatility & IV
    # -------------------------------------------------------------------------

    @staticmethod
    def _annualized_hv_percent(log_returns: pd.Series, window: int) -> float | None:
        """Annualized historical volatility from trailing log returns."""
        if len(log_returns) < window:
            return None
        val = _safe_float(log_returns.tail(window).std())
        return _round(val * (252**0.5) * 100) if val is not None else None

    @property
    def iv(self) -> float | None:
        """Proxy IV as weighted historical volatility (HV180/HV90/HV30/HV7/HV1)."""

        def _store_iv(value: float | None) -> float | None:
            self._iv_percent = value
            return value

        if self._iv_percent is not _UNSET:
            return cast(float | None, self._iv_percent)

        series = _close_series(self._history(period="1y", interval="1d"))
        if series is None or len(series) < 2:
            return _store_iv(None)

        with suppress(Exception):
            ratio = (series / series.shift(1)).replace([float("inf"), float("-inf")], pd.NA)
            log_returns = ratio.where(ratio > 0).map(math.log).dropna()
            if log_returns.empty:
                return _store_iv(None)

            weighted_sum, total_weight = 0.0, 0
            for window, weight in _HV_WINDOWS_TO_WEIGHTS:
                if (hv := self._annualized_hv_percent(log_returns, window)) is not None:
                    weighted_sum += hv * weight
                    total_weight += weight

            if total_weight == 0:
                return _store_iv(None)

            return _store_iv(_round(weighted_sum / total_weight))

        return _store_iv(None)

    # -------------------------------------------------------------------------
    # Technical Indicators
    # -------------------------------------------------------------------------

    def _calculate_rsi(self, days: int) -> float | None:
        """Calculate RSI for the given period."""
        try:
            series = _close_series(self._history(period=f"{days + 10}d"))
            if series is None or len(series) < days + 1:
                return None
            deltas = series.diff()
            avg_gain = float(deltas.where(deltas > 0, 0.0).rolling(window=days).mean().iloc[-1])
            avg_loss = float((-deltas.where(deltas < 0, 0.0)).rolling(window=days).mean().iloc[-1])
            if avg_loss == 0:
                return 100.0
            return _round(100 - (100 / (1 + avg_gain / avg_loss)))
        except Exception:
            return None

    @property
    def rsi(self) -> float | None:
        """Relative Strength Index (RSI)."""
        return self._calculate_rsi(DEFAULT_RSI_PERIOD)

    # -------------------------------------------------------------------------
    # Period Returns
    # -------------------------------------------------------------------------

    def _period_baseline_close(self, start_date: date, history_period: str) -> float | None:
        """Get period baseline close: prior-session close, else first close on/after start."""
        series = _close_series(self._history(period=history_period, interval="1d"))
        if series is None:
            return None
        try:
            index_dates = self._index_to_ny(series.index).date
            before = series.loc[index_dates < start_date]
            if not before.empty:
                return float(before.iloc[-1])
            on_or_after = series.loc[index_dates >= start_date]
            return float(on_or_after.iloc[0]) if not on_or_after.empty else None
        except Exception:
            return None

    def _calculate_period_return_percent(self, start_date: date, history_period: str) -> float | None:
        """Calculate return percent from the close before `start_date` to current price."""
        price = self.price
        baseline = self._period_baseline_close(start_date, history_period)
        if price is None or baseline is None or baseline == 0:
            return None
        return _round(((price / baseline) - 1) * 100)

    def _period_change_percent(self, period_key: str) -> float | None:
        """Calculate period change percent for a configured period key."""
        months, hist_period = _PERIOD_CONFIGS[period_key]
        return self._calculate_period_return_percent(_subtract_months(self._now_ny().date(), months), hist_period)

    @property
    def one_month_change_percent(self) -> float | None:
        """One month return percentage."""
        return self._period_change_percent("one_month")

    @property
    def three_month_change_percent(self) -> float | None:
        """Three month return percentage."""
        return self._period_change_percent("three_month")

    @property
    def six_month_change_percent(self) -> float | None:
        """Six month return percentage."""
        return self._period_change_percent("six_month")

    @property
    def one_year_change_percent(self) -> float | None:
        """One year return percentage."""
        return self._period_change_percent("one_year")

    @property
    def mtd_change_percent(self) -> float | None:
        """Month-to-date return percentage."""
        today = self._now_ny().date()
        return self._calculate_period_return_percent(date(today.year, today.month, 1), "3mo")

    @property
    def ytd_change_percent(self) -> float | None:
        """Year-to-date return percentage."""
        today = self._now_ny().date()
        if (ytd := self._calculate_period_return_percent(date(today.year, 1, 1), "2y")) is not None:
            return ytd
        return self._yahoo.get_ytd_return_percent()

    # -------------------------------------------------------------------------
    # Analyst Ratings
    # -------------------------------------------------------------------------

    @property
    def _ratings_payload(self) -> dict[str, Any] | None:
        """Lazily parse and cache analyst ratings."""
        if self._parsed_ratings is _UNSET:
            self._parsed_ratings = parse_ratings(self.ticker)
        return self._parsed_ratings if isinstance(self._parsed_ratings, dict) else None

    @property
    def ratings(self) -> list[dict[str, Any]] | None:
        """Raw analyst rating records."""
        payload = self._ratings_payload
        if not payload:
            return None
        val = payload.get("ratings")
        return val if isinstance(val, list) else None

    @property
    def median_upside(self) -> float | None:
        """Median analyst upside from recent ratings."""
        payload = self._ratings_payload
        return _safe_float(payload.get("median_upside_pct")) if payload else None

    # -------------------------------------------------------------------------
    # Aggregate
    # -------------------------------------------------------------------------

    def get_all_indicators(self) -> dict[str, Any]:
        """Get all available indicators as a dictionary."""
        return {field: getattr(self, field) for field in _INDICATOR_FIELDS}
