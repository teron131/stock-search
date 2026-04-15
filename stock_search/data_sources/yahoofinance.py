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

from stock_search.common_utils import round_optional, safe_float

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
    "change_percent_1m": (1, "2y"),
    "change_percent_3m": (3, "2y"),
    "change_percent_6m": (6, "2y"),
    "change_percent_1y": (12, "3y"),
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
_STATEMENT_NOT_LOADED = object()


def _subtract_months(value: date, months: int) -> date:
    """Subtract whole months from a date while clamping the day."""
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
    """Indicator-shaped payload produced directly from Yahoo data.

    Percent-based fields in this snapshot use percent units.
    """

    price: float | None = None
    change: float | None = None
    change_percent_1d: float | None = None
    market_cap: float | None = None
    pe: float | None = None
    pe_forward: float | None = None
    peg: float | None = None
    beta: float | None = None
    iv: float | None = None
    change_percent_1m: float | None = None
    change_percent_3m: float | None = None
    change_percent_6m: float | None = None
    change_percent_1y: float | None = None
    median_upside: float | None = None
    revenue_growth: float | None = None
    gross_margin: float | None = None
    operating_margin: float | None = None
    debt_to_equity: float | None = None
    free_cash_flow: float | None = None
    eps_diluted: float | None = None
    eps_growth: float | None = None
    rsi: float | None = None
    change_percent_mtd: float | None = None
    change_percent_ytd: float | None = None
    ratings: list[dict[str, Any]] | None = None


class YahooFinanceSource:
    """Provider-ready Yahoo Finance adapter."""

    def __init__(self, ticker: str | yf.Ticker):
        """Initialize the Yahoo Finance source for one ticker."""
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
        self._quarterly_income_stmt: pd.DataFrame | None | object = _STATEMENT_NOT_LOADED
        self._annual_income_stmt: pd.DataFrame | None | object = _STATEMENT_NOT_LOADED

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
        current_price = safe_float(info.get("currentPrice")) or safe_float(info.get("regularMarketPrice"))
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
        return safe_float(self.info.get(key))

    def get_current_price(self) -> float | None:
        """Best-effort current/regular price from Yahoo info."""
        return self.get_info_float("currentPrice") or self.get_info_float("regularMarketPrice")

    def get_previous_close(self) -> float | None:
        """Best-effort previous close from Yahoo info."""
        return self.get_info_float("regularMarketPreviousClose")

    def get_realtime_price(self, market_state: str) -> float | None:
        """Pick best available realtime price from pre/regular/post values."""
        price_entry = self._get_realtime_price_entry(market_state)
        return price_entry[1] if price_entry is not None else None

    def _get_realtime_price_entry(self, market_state: str) -> tuple[str, float] | None:
        """Pick the best available realtime price and return its Yahoo field key."""
        candidates = [
            (price_key, int(self.info.get(time_key) or 0), price) for price_key, time_key in _PRICE_TIME_KEYS if (price := safe_float(self.info.get(price_key))) is not None
        ]
        if candidates and any(timestamp > 0 for _, timestamp, _ in candidates):
            latest_key, _, latest_price = max(candidates, key=lambda item: item[1])
            return latest_key, round(latest_price, 2)

        preferred = _SESSION_PRICE_KEYS.get(market_state)
        for key in (preferred, *_PRICE_FALLBACK_ORDER):
            if key and (price := safe_float(self.info.get(key))) is not None:
                return key, round(price, 2)
        return None

    def _get_change_baseline_price(self, price_key: str | None) -> float | None:
        """Choose the correct change baseline for the selected price field."""
        if price_key in {"preMarketPrice", "postMarketPrice"}:
            regular_market_price = round_optional(self.get_info_float("regularMarketPrice"))
            if regular_market_price is not None:
                return regular_market_price

        previous_close_info = round_optional(self.get_previous_close())
        if previous_close_info is not None:
            return previous_close_info
        return self._previous_close_from_history()

    def _build_session_quote(self) -> tuple[float | None, float | None, float | None]:
        """Build price/change/change_percent_1d with the correct session baseline."""
        price_entry = self._get_realtime_price_entry(self.get_market_state())
        price = price_entry[1] if price_entry is not None else None
        if price is None:
            price = round_optional(self.get_current_price()) or self._last_intraday_price() or self._last_close()
        baseline_price = self._get_change_baseline_price(price_entry[0] if price_entry is not None else None)
        change = round_optional(price - baseline_price) if price is not None and baseline_price is not None else None
        change_percent_1d = round_optional(((price - baseline_price) / baseline_price) * 100) if price is not None and baseline_price not in (None, 0) else None
        return price, change, change_percent_1d

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
        """Get revenue growth in percentage points from Yahoo info."""
        return self.get_ratio_percent("revenueGrowth")

    def _get_quarterly_income_stmt(self) -> pd.DataFrame | None:
        """Get cached quarterly income statement for TTM-based calculations."""
        if self._quarterly_income_stmt is _STATEMENT_NOT_LOADED:
            statement: pd.DataFrame | None = None
            with suppress(Exception):
                qinc = self.ticker.quarterly_income_stmt
                if isinstance(qinc, pd.DataFrame) and not qinc.empty:
                    statement = qinc
            self._quarterly_income_stmt = statement
        return cast(pd.DataFrame | None, self._quarterly_income_stmt)

    def _get_annual_income_stmt(self) -> pd.DataFrame | None:
        """Get cached annual income statement for fallback calculations."""
        if self._annual_income_stmt is _STATEMENT_NOT_LOADED:
            statement: pd.DataFrame | None = None
            with suppress(Exception):
                inc = self.ticker.income_stmt
                if isinstance(inc, pd.DataFrame) and not inc.empty:
                    statement = inc
            self._annual_income_stmt = statement
        return cast(pd.DataFrame | None, self._annual_income_stmt)

    def _quarterly_metric_series(self, row_names: tuple[str, ...]) -> pd.Series | None:
        """Select a quarterly metric row and coerce it to numeric values."""
        statement = self._get_quarterly_income_stmt()
        if statement is None:
            return None
        for row_name in row_names:
            if row_name in statement.index:
                series = pd.to_numeric(statement.loc[row_name], errors="coerce")
                return series if isinstance(series, pd.Series) and not series.empty else None
        return None

    def _annual_metric_series(self, row_names: tuple[str, ...]) -> pd.Series | None:
        """Select an annual metric row and coerce it to numeric values."""
        statement = self._get_annual_income_stmt()
        if statement is None:
            return None
        for row_name in row_names:
            if row_name in statement.index:
                series = pd.to_numeric(statement.loc[row_name], errors="coerce")
                return series if isinstance(series, pd.Series) and not series.empty else None
        return None

    @staticmethod
    def _sum_quarters(values: pd.Series, *, count: int, offset: int = 0) -> float | None:
        """Sum a strict quarterly window; returns None if any value is missing."""
        window = values.iloc[offset : offset + count]
        if len(window) < count or window.isna().any():
            return None
        return float(window.sum())

    def get_gross_margin_percent(self) -> float | None:
        """Get TTM gross margin in percentage points from quarterly statements."""
        revenue_series = self._quarterly_metric_series(("Total Revenue", "Revenue"))
        gross_profit_series = self._quarterly_metric_series(("Gross Profit",))
        revenue_ttm = self._sum_quarters(revenue_series, count=4, offset=0) if revenue_series is not None else None
        gross_profit_ttm = self._sum_quarters(gross_profit_series, count=4, offset=0) if gross_profit_series is not None else None
        if revenue_ttm in (None, 0) or gross_profit_ttm is None:
            annual_revenue = self._annual_metric_series(("Total Revenue", "Revenue"))
            annual_gross_profit = self._annual_metric_series(("Gross Profit",))
            if annual_revenue is None or annual_gross_profit is None:
                return None
            revenue_latest = self._sum_quarters(annual_revenue, count=1, offset=0)
            gross_profit_latest = self._sum_quarters(annual_gross_profit, count=1, offset=0)
            if revenue_latest in (None, 0) or gross_profit_latest is None:
                return None
            return round_optional((gross_profit_latest / revenue_latest) * 100)
        return round_optional((gross_profit_ttm / revenue_ttm) * 100)

    def get_operating_margin_percent(self) -> float | None:
        """Get TTM operating margin in percentage points from quarterly statements."""
        revenue_series = self._quarterly_metric_series(("Total Revenue", "Revenue"))
        operating_income_series = self._quarterly_metric_series(("Operating Income", "OperatingIncome"))
        revenue_ttm = self._sum_quarters(revenue_series, count=4, offset=0) if revenue_series is not None else None
        operating_income_ttm = self._sum_quarters(operating_income_series, count=4, offset=0) if operating_income_series is not None else None
        if revenue_ttm in (None, 0) or operating_income_ttm is None:
            annual_revenue = self._annual_metric_series(("Total Revenue", "Revenue"))
            annual_operating_income = self._annual_metric_series(("Operating Income", "OperatingIncome"))
            if annual_revenue is None or annual_operating_income is None:
                return None
            revenue_latest = self._sum_quarters(annual_revenue, count=1, offset=0)
            operating_income_latest = self._sum_quarters(annual_operating_income, count=1, offset=0)
            if revenue_latest in (None, 0) or operating_income_latest is None:
                return None
            return round_optional((operating_income_latest / revenue_latest) * 100)
        return round_optional((operating_income_ttm / revenue_ttm) * 100)

    def get_debt_to_equity_percent(self) -> float | None:
        """Get debt-to-equity percentage from Yahoo info."""
        value = self.get_info_float("debtToEquity")
        return round(value, 2) if value is not None else None

    def get_eps_diluted(self) -> float | None:
        """Get TTM diluted EPS from quarterly statements."""
        values = self._quarterly_metric_series(("Diluted EPS", "DilutedEPS"))
        if values is not None:
            eps_ttm = self._sum_quarters(values, count=4, offset=0)
            if eps_ttm is not None:
                return round_optional(eps_ttm)
        annual_values = self._annual_metric_series(("Diluted EPS", "DilutedEPS"))
        if annual_values is None:
            return None
        eps_latest = self._sum_quarters(annual_values, count=1, offset=0)
        return round_optional(eps_latest) if eps_latest is not None else None

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
        """Convert a datetime index into New York time."""
        return index.tz_convert(NY_TZ) if index.tz else index.tz_localize(NY_TZ)

    @staticmethod
    def _now_ny() -> datetime:
        """Return the current time in New York."""
        return datetime.now(tz=NY_TZ)

    @staticmethod
    def _infer_session(now_ny: datetime) -> str:
        """Infer the current market session from New York time."""
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
        """Return the datetime bounds for one market session."""
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
        """Extract the latest close inside the requested session window."""
        series = _close_series(hist)
        if series is None:
            return None
        try:
            if window:
                index_ny = self._index_to_ny(hist.index)
                scoped = hist.loc[(index_ny >= window[0]) & (index_ny < window[1])]
                scoped_series = _close_series(scoped)
                if scoped_series is not None:
                    return round_optional(float(scoped_series.iloc[-1]))
            return round_optional(float(series.iloc[-1]))
        except Exception:
            return None

    def _last_intraday_price(self) -> float | None:
        """Return the latest available intraday price."""
        now_ny = self._now_ny()
        session = self.get_market_state() or self._infer_session(now_ny)
        window = self._session_window(now_ny, session)
        for interval in _INTRADAY_INTERVALS:
            hist = self.get_history_snapshot(period="1d", interval=interval, prepost=True).history
            if (price := self._extract_session_close(hist, window)) is not None:
                return price
        return None

    def _daily_close_series(self) -> pd.Series | None:
        """Return the daily close-price series."""
        return _close_series(self.get_history_snapshot(period=_DAILY_HISTORY_PERIOD, interval=_DAILY_INTERVAL).history)

    def _last_close(self) -> float | None:
        """Return the latest daily close price."""
        series = self._daily_close_series()
        if series is None:
            return None
        with suppress(Exception):
            return round_optional(float(series.iloc[-1]))
        return None

    def _previous_close_from_history(self) -> float | None:
        """Return the previous daily close price from history."""
        series = self._daily_close_series()
        if series is None:
            return None
        with suppress(Exception):
            idx = -2 if len(series) >= 2 else -1
            return round_optional(float(series.iloc[idx]))
        return None

    def _period_baseline_close(self, start_date: date, history_period: str) -> float | None:
        """Return the baseline close used for a period-return calculation."""
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
        """Calculate period return percent."""
        baseline = self._period_baseline_close(start_date, history_period)
        if price is None or baseline is None or baseline == 0:
            return None
        return round_optional(((price / baseline) - 1) * 100)

    def _calculate_rsi(self, days: int = DEFAULT_RSI_PERIOD) -> float | None:
        """Calculate RSI."""
        try:
            series = _close_series(self.get_history_snapshot(period=f"{days + 10}d").history)
            if series is None or len(series) < days + 1:
                return None
            deltas = series.diff()
            avg_gain = float(deltas.where(deltas > 0, 0.0).rolling(window=days).mean().iloc[-1])
            avg_loss = float((-deltas.where(deltas < 0, 0.0)).rolling(window=days).mean().iloc[-1])
            if avg_loss == 0:
                return 100.0
            return round_optional(100 - (100 / (1 + avg_gain / avg_loss)))
        except Exception:
            return None

    @staticmethod
    def _annualized_hv_percent(log_returns: pd.Series, window: int) -> float | None:
        """Annualize historical volatility into percentage points."""
        if len(log_returns) < window:
            return None
        val = safe_float(log_returns.tail(window).std())
        return round_optional(val * (252**0.5) * 100) if val is not None else None

    def _calculate_iv(self) -> float | None:
        """Calculate IV."""
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
            return round_optional(weighted_sum / total_weight)
        return None

    def get_indicators_snapshot(self, ratings_days: int = 90) -> YahooIndicatorsSnapshot:
        """Build and cache a Yahoo-only indicator set for orchestrator usage."""
        if ratings_days in self._indicator_cache:
            return self._indicator_cache[ratings_days]

        price, change, change_percent_1d = self._build_session_quote()

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
            change_percent_1d=change_percent_1d,
            market_cap=self.get_market_cap(),
            pe=self.get_pe_trailing(),
            pe_forward=self.get_forward_pe_ntm(),
            peg=self.get_peg(),
            beta=self.get_beta(),
            iv=self._calculate_iv(),
            change_percent_1m=period_values["change_percent_1m"],
            change_percent_3m=period_values["change_percent_3m"],
            change_percent_6m=period_values["change_percent_6m"],
            change_percent_1y=period_values["change_percent_1y"],
            median_upside=ratings_snapshot.median_upside_pct if ratings_snapshot else None,
            revenue_growth=self.get_revenue_growth_percent(),
            gross_margin=self.get_gross_margin_percent(),
            operating_margin=self.get_operating_margin_percent(),
            debt_to_equity=self.get_debt_to_equity_percent(),
            free_cash_flow=self.get_free_cash_flow_in_quote_currency(),
            eps_diluted=self.get_eps_diluted(),
            eps_growth=None,
            rsi=self._calculate_rsi(),
            change_percent_mtd=mtd,
            change_percent_ytd=ytd,
            ratings=ratings_snapshot.ratings if ratings_snapshot else None,
        )
        self._indicator_cache[ratings_days] = snapshot
        return snapshot
