"""Yahoo Finance source adapter.

This module exposes provider-ready Yahoo snapshots for info, history, and analyst ratings. The adapter is intentionally source-local and does not apply cross-provider fallback. Downstream orchestration should handle precedence.
"""

from __future__ import annotations

from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from functools import cache
import math
from typing import Any, cast
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

ETF_QUOTE_TYPE = "ETF"
DEFAULT_FX_LOOKBACK_PERIOD = "5d"
DEFAULT_FX_INTERVAL = "1d"
DEFAULT_RSI_PERIOD = 14
NY_TZ = ZoneInfo("America/New_York")
_SESSION_PRE_START = time(4, 0)
_SESSION_REGULAR_START = time(9, 30)
_SESSION_REGULAR_END = time(16, 0)
_SESSION_POST_END = time(20, 0)
_SESSION_WINDOWS: dict[str, tuple[time, time]] = {
    "PRE": (_SESSION_PRE_START, _SESSION_REGULAR_START),
    "REGULAR": (_SESSION_REGULAR_START, _SESSION_REGULAR_END),
    "POST": (_SESSION_REGULAR_END, _SESSION_POST_END),
    "POSTPOST": (_SESSION_REGULAR_END, _SESSION_POST_END),
}
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
_PERIOD_CONFIGS: dict[str, tuple[int, str]] = {
    "one_month_change_percent": (1, "2y"),
    "three_month_change_percent": (3, "2y"),
    "six_month_change_percent": (6, "2y"),
    "one_year_change_percent": (12, "3y"),
}
_SESSION_PRICE_KEYS: dict[str, str] = {
    "PRE": "preMarketPrice",
    "POST": "postMarketPrice",
    "POSTPOST": "postMarketPrice",
    "CLOSED": "postMarketPrice",
    "REGULAR": "regularMarketPrice",
}
_PRICE_FALLBACK_ORDER = ("regularMarketPrice", "postMarketPrice", "preMarketPrice")
_PRICE_TIME_KEYS: tuple[tuple[str, str], ...] = (
    ("preMarketPrice", "preMarketTime"),
    ("regularMarketPrice", "regularMarketTime"),
    ("postMarketPrice", "postMarketTime"),
)


def _safe_float(value: Any) -> float | None:
    """Safely parse finite float values from provider payloads."""
    with suppress(TypeError, ValueError):
        converted = float(value)
        return converted if math.isfinite(converted) else None
    return None


def _round(value: float | None, decimals: int = 2) -> float | None:
    return round(float(value), decimals) if value is not None else None


def _subtract_months(value: date, months: int) -> date:
    year, month = value.year, value.month - months
    while month <= 0:
        month += 12
        year -= 1
    month_days = [31, 29 if (year % 400 == 0 or (year % 4 == 0 and year % 100 != 0)) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return date(year, month, min(value.day, month_days[month - 1]))


def normalize_yahoo_ticker(ticker: str) -> str:
    """Normalize ticker format for Yahoo endpoints."""
    return ticker.strip().upper().replace(" ", "-").replace(".", "-")


def _fiscal_weight_fy0(next_fiscal_year_end: float | None) -> float | None:
    """Weight of FY0 in a 12-month lookahead window."""
    if next_fiscal_year_end is None:
        return None
    days = (datetime.fromtimestamp(next_fiscal_year_end, tz=UTC) - datetime.now(tz=UTC)).total_seconds() / 86_400
    return min(1.0, max(0.0, days / 365.0))


def _close_series(hist: pd.DataFrame) -> pd.Series | None:
    """Return non-empty close series from a history frame."""
    if hist.empty or "Close" not in hist:
        return None
    series = hist["Close"].dropna()
    return series if not series.empty else None


def _latest_close_price(hist: pd.DataFrame) -> float | None:
    """Get latest non-null close from history frame."""
    series = _close_series(hist)
    return float(series.iloc[-1]) if series is not None else None


@cache
def _fx_rate(from_currency: str, to_currency: str) -> float | None:
    """Best-effort FX rate from `from_currency` to `to_currency`."""
    source, target = from_currency.strip().upper(), to_currency.strip().upper()
    if not source or not target:
        return None
    if source == target:
        return 1.0

    for pair, invert in ((f"{source}{target}=X", False), (f"{target}{source}=X", True)):
        with suppress(Exception):
            hist = yf.Ticker(pair).history(
                period=DEFAULT_FX_LOOKBACK_PERIOD,
                interval=DEFAULT_FX_INTERVAL,
            )
            if (price := _latest_close_price(hist)) is not None and price != 0:
                return 1.0 / price if invert else price
    return None


@dataclass(frozen=True)
class YahooInfoSnapshot:
    """Raw Yahoo `info` payload snapshot."""

    raw_info: dict[str, Any]


@dataclass(frozen=True)
class YahooHistorySnapshot:
    """Historical OHLCV snapshot from Yahoo history."""

    period: str
    interval: str | None
    prepost: bool
    history: pd.DataFrame


@dataclass(frozen=True)
class YahooRatingsSnapshot:
    """Analyst ratings snapshot derived from upgrades/downgrades."""

    median_upside_pct: float | None
    ratings: list[dict[str, Any]]


@dataclass(frozen=True)
class YahooIndicatorsSnapshot:
    """Indicator-shaped payload produced directly from Yahoo data."""

    price: float | None = None
    change: float | None = None
    change_percent: float | None = None
    market_cap: float | None = None
    pe: float | None = None
    pe_forward: float | None = None
    peg: float | None = None
    beta: float | None = None
    iv: float | None = None
    one_month_change_percent: float | None = None
    three_month_change_percent: float | None = None
    six_month_change_percent: float | None = None
    one_year_change_percent: float | None = None
    median_upside: float | None = None
    revenue_growth: float | None = None
    gross_margin: float | None = None
    debt_to_equity: float | None = None
    free_cash_flow: float | None = None
    rsi: float | None = None
    mtd_change_percent: float | None = None
    ytd_change_percent: float | None = None
    ratings: list[dict[str, Any]] | None = None


class YahooFinanceSource:
    """Provider-ready Yahoo Finance adapter."""

    def __init__(self, ticker: str | yf.Ticker):
        if isinstance(ticker, yf.Ticker):
            self.ticker = ticker
            symbol = str(getattr(ticker, "ticker", "") or "")
            self.ticker_symbol = normalize_yahoo_ticker(symbol) if symbol else ""
        else:
            self.ticker_symbol = normalize_yahoo_ticker(ticker)
            self.ticker = yf.Ticker(self.ticker_symbol)
        self._info_snapshot: YahooInfoSnapshot | None = None
        self._history_cache: dict[str, YahooHistorySnapshot] = {}
        self._ratings_cache: dict[int, YahooRatingsSnapshot | None] = {}
        self._indicator_cache: dict[int, YahooIndicatorsSnapshot] = {}

    @property
    def info(self) -> dict[str, Any]:
        """Convenience accessor for cached Yahoo info payload."""
        return self.get_info_snapshot().raw_info

    def get_info_snapshot(self) -> YahooInfoSnapshot:
        """Fetch and cache a Yahoo `info` snapshot."""
        if self._info_snapshot is None:
            info: dict[str, Any] = {}
            with suppress(Exception):
                info = self.ticker.info or {}
            self._info_snapshot = YahooInfoSnapshot(raw_info=info)
        return self._info_snapshot

    def get_history_snapshot(
        self,
        *,
        period: str,
        interval: str | None = None,
        prepost: bool = False,
    ) -> YahooHistorySnapshot:
        """Fetch and cache a Yahoo history snapshot for the given request."""
        cache_key = f"{period}|{interval or ''}|prepost={prepost}"
        if cache_key in self._history_cache:
            return self._history_cache[cache_key]

        history = pd.DataFrame()
        with suppress(Exception):
            kwargs: dict[str, Any] = {"period": period, "prepost": prepost}
            if interval:
                kwargs["interval"] = interval
            result = self.ticker.history(**kwargs)
            if isinstance(result, pd.DataFrame):
                history = result

        snapshot = YahooHistorySnapshot(
            period=period,
            interval=interval,
            prepost=prepost,
            history=history,
        )
        self._history_cache[cache_key] = snapshot
        return snapshot

    def get_ratings_snapshot(self, days: int = 90) -> YahooRatingsSnapshot | None:
        """Fetch and cache analyst ratings snapshot over a lookback window."""
        if days in self._ratings_cache:
            return self._ratings_cache[days]

        info = self.get_info_snapshot().raw_info
        current_price = _safe_float(info.get("currentPrice")) or _safe_float(info.get("regularMarketPrice"))
        if current_price is None:
            self._ratings_cache[days] = None
            return None

        ratings_data: Any = None
        with suppress(Exception):
            ratings_data = self.ticker.upgrades_downgrades

        if ratings_data is None or isinstance(ratings_data, dict):
            self._ratings_cache[days] = None
            return None
        if isinstance(ratings_data, pd.DataFrame) and ratings_data.empty:
            self._ratings_cache[days] = None
            return None

        ratings_df = cast(pd.DataFrame, ratings_data).copy()
        try:
            ratings_df.index = pd.to_datetime(ratings_df.index, utc=True)
            cutoff = datetime.now(UTC) - timedelta(days=days)
            recent = ratings_df[ratings_df.index >= cutoff]
            if recent.empty:
                self._ratings_cache[days] = None
                return None

            upside_pct = ((recent["currentPriceTarget"] - current_price) / current_price * 100).round(2)
            snapshot = YahooRatingsSnapshot(
                median_upside_pct=float(upside_pct.median()),
                ratings=recent.to_dict("records"),
            )
            self._ratings_cache[days] = snapshot
            return snapshot
        except Exception:
            self._ratings_cache[days] = None
            return None

    def get_quote_type(self) -> str:
        """Get normalized Yahoo quote type."""
        return str(self.info.get("quoteType") or "").upper()

    def get_market_state(self) -> str:
        """Get normalized Yahoo market state."""
        return str(self.info.get("marketState") or "").upper()

    def get_info_float(self, key: str) -> float | None:
        """Read and parse float-like value from Yahoo info."""
        return _safe_float(self.info.get(key))

    def get_current_price(self) -> float | None:
        """Best-effort current/regular price from Yahoo info."""
        return self.get_info_float("currentPrice") or self.get_info_float("regularMarketPrice")

    def get_previous_close(self) -> float | None:
        """Best-effort previous close from Yahoo info."""
        return self.get_info_float("regularMarketPreviousClose")

    def get_realtime_price(self, market_state: str) -> float | None:
        """Pick best available realtime price from pre/regular/post values."""
        candidates = [(int(self.info.get(time_key) or 0), price) for price_key, time_key in _PRICE_TIME_KEYS if (price := _safe_float(self.info.get(price_key))) is not None]
        if candidates and any(ts > 0 for ts, _ in candidates):
            return round(max(candidates, key=lambda x: x[0])[1], 2)

        preferred = _SESSION_PRICE_KEYS.get(market_state)
        for key in (preferred, *_PRICE_FALLBACK_ORDER):
            if key and (price := _safe_float(self.info.get(key))) is not None:
                return round(price, 2)
        return None

    def get_market_cap(self) -> float | None:
        """Get raw market cap in dollars."""
        return self.get_info_float("marketCap")

    def get_pe_trailing(self) -> float | None:
        """Get trailing PE from Yahoo info."""
        if (value := self.get_info_float("trailingPE")) is None:
            return None
        return round(value, 2)

    def get_peg(self) -> float | None:
        """Get trailing PEG ratio from Yahoo info."""
        if (value := self.get_info_float("trailingPegRatio")) is None:
            return None
        return round(value, 2)

    def get_beta(self) -> float | None:
        """Get beta using primary key then 3-year fallback."""
        value = self.get_info_float("beta") or self.get_info_float("beta3Year")
        return round(value, 2) if value is not None else None

    def get_ratio_percent(self, key: str) -> float | None:
        """Read ratio from Yahoo info and convert to percentage points."""
        ratio = self.get_info_float(key)
        return round(ratio * 100, 2) if ratio is not None else None

    def get_revenue_growth_percent(self) -> float | None:
        """Get revenue growth in percentage points."""
        return self.get_ratio_percent("revenueGrowth")

    def get_gross_margin_percent(self) -> float | None:
        """Get gross margin in percentage points."""
        return self.get_ratio_percent("grossMargins")

    def get_debt_to_equity_percent(self) -> float | None:
        """Get debt-to-equity percentage from Yahoo info."""
        value = self.get_info_float("debtToEquity")
        return round(value, 2) if value is not None else None

    def get_ytd_return_percent(self) -> float | None:
        """Get Yahoo ytdReturn and convert to percentage points."""
        return self.get_ratio_percent("ytdReturn")

    def get_free_cash_flow_in_quote_currency(self) -> float | None:
        """Get free cash flow converted into quote currency when needed."""
        fcf = self.get_info_float("freeCashflow")
        if fcf is None:
            return None
        fin_curr = str(self.info.get("financialCurrency") or "").upper()
        quote_curr = str(self.info.get("currency") or "").upper()
        if not fin_curr or not quote_curr or fin_curr == quote_curr:
            return fcf
        rate = _fx_rate(fin_curr, quote_curr)
        return fcf * rate if rate else None

    def get_forward_pe_ntm(self) -> float | None:
        """Compute forward PE using FY0/FY1 NTM blend, with FY1 fallback."""
        if self.get_quote_type() == ETF_QUOTE_TYPE:
            return None
        price = self.get_current_price()
        if price is None or price <= 0:
            return None

        eps_fy0 = self.get_info_float("epsCurrentYear")
        eps_fy1 = self.get_info_float("forwardEps")
        if eps_fy0 is not None and eps_fy1 is not None:
            weight_fy0 = _fiscal_weight_fy0(self.get_info_float("nextFiscalYearEnd"))
            if weight_fy0 is not None:
                eps_ntm = (weight_fy0 * eps_fy0) + ((1 - weight_fy0) * eps_fy1)
                if eps_ntm != 0:
                    return round(price / eps_ntm, 2)

        if eps_fy1 is not None and eps_fy1 != 0:
            return round(price / eps_fy1, 2)
        return None

    @staticmethod
    def _index_to_ny(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
        return index.tz_convert(NY_TZ) if index.tz else index.tz_localize(NY_TZ)

    @staticmethod
    def _now_ny() -> datetime:
        return datetime.now(tz=NY_TZ)

    @staticmethod
    def _infer_session(now_ny: datetime) -> str:
        if now_ny.weekday() >= 5:
            return "CLOSED"
        now_time = now_ny.timetz().replace(tzinfo=None)
        if _SESSION_PRE_START <= now_time < _SESSION_REGULAR_START:
            return "PRE"
        if _SESSION_REGULAR_START <= now_time < _SESSION_REGULAR_END:
            return "REGULAR"
        if _SESSION_REGULAR_END <= now_time < _SESSION_POST_END:
            return "POST"
        return "CLOSED"

    @staticmethod
    def _session_window(now_ny: datetime, session: str) -> tuple[datetime, datetime] | None:
        if session not in _SESSION_WINDOWS:
            return None
        start_t, end_t = _SESSION_WINDOWS[session]
        d = now_ny.date()
        return datetime.combine(d, start_t, tzinfo=NY_TZ), datetime.combine(d, end_t, tzinfo=NY_TZ)

    def _extract_session_close(
        self,
        hist: pd.DataFrame,
        window: tuple[datetime, datetime] | None,
    ) -> float | None:
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
        now_ny = self._now_ny()
        session = self.get_market_state() or self._infer_session(now_ny)
        window = self._session_window(now_ny, session)
        for interval in _INTRADAY_INTERVALS:
            hist = self.get_history_snapshot(period="1d", interval=interval, prepost=True).history
            if (price := self._extract_session_close(hist, window)) is not None:
                return price
        return None

    def _daily_close_series(self) -> pd.Series | None:
        return _close_series(self.get_history_snapshot(period=_DAILY_HISTORY_PERIOD, interval=_DAILY_INTERVAL).history)

    def _last_close(self) -> float | None:
        series = self._daily_close_series()
        if series is None:
            return None
        with suppress(Exception):
            return _round(float(series.iloc[-1]))
        return None

    def _previous_close_from_history(self) -> float | None:
        series = self._daily_close_series()
        if series is None:
            return None
        with suppress(Exception):
            idx = -2 if len(series) >= 2 else -1
            return _round(float(series.iloc[idx]))
        return None

    def _period_baseline_close(self, start_date: date, history_period: str) -> float | None:
        series = _close_series(self.get_history_snapshot(period=history_period, interval="1d").history)
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

    def _calculate_period_return_percent(self, *, start_date: date, history_period: str, price: float | None) -> float | None:
        baseline = self._period_baseline_close(start_date, history_period)
        if price is None or baseline is None or baseline == 0:
            return None
        return _round(((price / baseline) - 1) * 100)

    def _calculate_rsi(self, days: int = DEFAULT_RSI_PERIOD) -> float | None:
        try:
            series = _close_series(self.get_history_snapshot(period=f"{days + 10}d").history)
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

    @staticmethod
    def _annualized_hv_percent(log_returns: pd.Series, window: int) -> float | None:
        if len(log_returns) < window:
            return None
        val = _safe_float(log_returns.tail(window).std())
        return _round(val * (252**0.5) * 100) if val is not None else None

    def _calculate_iv(self) -> float | None:
        series = _close_series(self.get_history_snapshot(period="1y", interval="1d").history)
        if series is None or len(series) < 2:
            return None
        with suppress(Exception):
            ratio = (series / series.shift(1)).replace([float("inf"), float("-inf")], pd.NA)
            log_returns = ratio.where(ratio > 0).map(math.log).dropna()
            if log_returns.empty:
                return None
            weighted_sum, total_weight = 0.0, 0
            for window, weight in _HV_WINDOWS_TO_WEIGHTS:
                if (hv := self._annualized_hv_percent(log_returns, window)) is not None:
                    weighted_sum += hv * weight
                    total_weight += weight
            if total_weight == 0:
                return None
            return _round(weighted_sum / total_weight)
        return None

    def get_indicators_snapshot(self, ratings_days: int = 90) -> YahooIndicatorsSnapshot:
        """Build and cache a Yahoo-only indicator set for orchestrator usage."""
        if ratings_days in self._indicator_cache:
            return self._indicator_cache[ratings_days]

        price = self.get_realtime_price(self.get_market_state()) or _round(self.get_current_price()) or self._last_intraday_price() or self._last_close()
        previous_close_info = _round(self.get_previous_close())
        previous_close = previous_close_info if previous_close_info is not None else self._previous_close_from_history()
        change = _round(price - previous_close) if price is not None and previous_close is not None else None
        change_percent = _round(((price - previous_close) / previous_close) * 100) if price is not None and previous_close not in (None, 0) else None

        now = self._now_ny().date()
        period_values = {
            field: self._calculate_period_return_percent(
                start_date=_subtract_months(now, months),
                history_period=hist_period,
                price=price,
            )
            for field, (months, hist_period) in _PERIOD_CONFIGS.items()
        }
        mtd = self._calculate_period_return_percent(start_date=date(now.year, now.month, 1), history_period="3mo", price=price)
        ytd_period = self._calculate_period_return_percent(start_date=date(now.year, 1, 1), history_period="2y", price=price)
        ytd = ytd_period if ytd_period is not None else self.get_ytd_return_percent()

        ratings_snapshot = self.get_ratings_snapshot(days=ratings_days)
        snapshot = YahooIndicatorsSnapshot(
            price=price,
            change=change,
            change_percent=change_percent,
            market_cap=self.get_market_cap(),
            pe=self.get_pe_trailing(),
            pe_forward=self.get_forward_pe_ntm(),
            peg=self.get_peg(),
            beta=self.get_beta(),
            iv=self._calculate_iv(),
            one_month_change_percent=period_values["one_month_change_percent"],
            three_month_change_percent=period_values["three_month_change_percent"],
            six_month_change_percent=period_values["six_month_change_percent"],
            one_year_change_percent=period_values["one_year_change_percent"],
            median_upside=ratings_snapshot.median_upside_pct if ratings_snapshot else None,
            revenue_growth=self.get_revenue_growth_percent(),
            gross_margin=self.get_gross_margin_percent(),
            debt_to_equity=self.get_debt_to_equity_percent(),
            free_cash_flow=self.get_free_cash_flow_in_quote_currency(),
            rsi=self._calculate_rsi(),
            mtd_change_percent=mtd,
            ytd_change_percent=ytd,
            ratings=ratings_snapshot.ratings if ratings_snapshot else None,
        )
        self._indicator_cache[ratings_days] = snapshot
        return snapshot
