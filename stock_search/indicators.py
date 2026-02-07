import calendar
from contextlib import suppress
from datetime import UTC, date, datetime, time, timedelta
from functools import cache
import logging
from typing import Any, cast
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# --- Configuration ---
DEFAULT_RATINGS_LOOKBACK_DAYS = 90
DEFAULT_RSI_PERIOD = 14
DEFAULT_FX_LOOKBACK_PERIOD = "5d"
DEFAULT_FX_INTERVAL = "1d"

PERIOD_RETURN_WINDOWS: dict[str, tuple[int, str]] = {
    "one_month_change_percent": (1, "2y"),
    "three_month_change_percent": (3, "2y"),
    "six_month_change_percent": (6, "2y"),
    "one_year_change_percent": (12, "3y"),
}

# --- Market State Constants ---
MARKET_STATE_PRE = "PRE"
MARKET_STATE_REGULAR = "REGULAR"
MARKET_STATE_POST = "POST"
MARKET_STATE_POSTPOST = "POSTPOST"
MARKET_STATE_CLOSED = "CLOSED"

# --- Timezone & Session Hours ---
NY_TZ = ZoneInfo("America/New_York")
_SESSION_PRE_START = time(4, 0)
_SESSION_REGULAR_START = time(9, 30)
_SESSION_REGULAR_END = time(16, 0)
_SESSION_POST_END = time(20, 0)

# --- Price Keys by Session ---
_SESSION_PRICE_KEYS: dict[str, str] = {
    MARKET_STATE_PRE: "preMarketPrice",
    MARKET_STATE_POST: "postMarketPrice",
    MARKET_STATE_POSTPOST: "postMarketPrice",
    MARKET_STATE_CLOSED: "postMarketPrice",
    MARKET_STATE_REGULAR: "regularMarketPrice",
}

_PRICE_FALLBACK_ORDER = ("regularMarketPrice", "postMarketPrice", "preMarketPrice")
_PRICE_TIME_KEYS: tuple[tuple[str, str], ...] = (
    ("preMarketPrice", "preMarketTime"),
    ("regularMarketPrice", "regularMarketTime"),
    ("postMarketPrice", "postMarketTime"),
)
_SESSION_WINDOWS: dict[str, tuple[time, time]] = {
    MARKET_STATE_PRE: (_SESSION_PRE_START, _SESSION_REGULAR_START),
    MARKET_STATE_REGULAR: (_SESSION_REGULAR_START, _SESSION_REGULAR_END),
    MARKET_STATE_POST: (_SESSION_REGULAR_END, _SESSION_POST_END),
    MARKET_STATE_POSTPOST: (_SESSION_REGULAR_END, _SESSION_POST_END),
}
_INTRADAY_PRICE_INTERVALS = ("1m", "5m", "15m")
_DAILY_HISTORY_PERIOD = "5d"
_DAILY_INTERVAL = "1d"
_UNSET = object()


def _round(value: float | None, decimals: int = 2) -> float | None:
    """Round a value if not None."""
    return round(float(value), decimals) if value is not None else None


def _safe_float(value: Any) -> float | None:
    """Convert value to float when possible."""
    with suppress(TypeError, ValueError):
        return float(value)
    return None


def _normalize_yahoo_ticker(ticker: str) -> str:
    """Normalize common ticker variants for Yahoo Finance."""
    return ticker.strip().upper().replace(" ", "-").replace(".", "-")


def _latest_close_price(hist: pd.DataFrame) -> float | None:
    """Get latest non-null close from a history frame."""
    if not isinstance(hist, pd.DataFrame) or hist.empty or "Close" not in hist:
        return None
    close = hist["Close"].dropna()
    if close.empty:
        return None
    return float(close.iloc[-1])


@cache
def _fx_rate(from_currency: str, to_currency: str) -> float | None:
    """Best-effort FX rate from `from_currency` to `to_currency`."""
    source = from_currency.strip().upper()
    target = to_currency.strip().upper()
    if not source or not target:
        return None
    if source == target:
        return 1.0

    direct_pair = f"{source}{target}=X"
    inverse_pair = f"{target}{source}=X"

    with suppress(Exception):
        direct_hist = yf.Ticker(direct_pair).history(
            period=DEFAULT_FX_LOOKBACK_PERIOD,
            interval=DEFAULT_FX_INTERVAL,
        )
        if (price := _latest_close_price(direct_hist)) is not None:
            return price

    with suppress(Exception):
        inverse_hist = yf.Ticker(inverse_pair).history(
            period=DEFAULT_FX_LOOKBACK_PERIOD,
            interval=DEFAULT_FX_INTERVAL,
        )
        if (price := _latest_close_price(inverse_hist)) is not None and price != 0:
            return 1.0 / price

    return None


def _subtract_months(value: date, months: int) -> date:
    """Return a date shifted back by N calendar months."""
    year = value.year
    month = value.month - months
    while month <= 0:
        month += 12
        year -= 1
    max_day = calendar.monthrange(year, month)[1]
    return date(year, month, min(value.day, max_day))


def parse_ratings(
    ticker: str | yf.Ticker,
    days: int = DEFAULT_RATINGS_LOOKBACK_DAYS,
) -> dict[str, Any] | None:
    """Parse analyst ratings for a ticker and calculate upside metrics."""
    stock = ticker if isinstance(ticker, yf.Ticker) else yf.Ticker(ticker)

    info: dict[str, Any] = {}
    with suppress(Exception):
        info = stock.info or {}

    current_price = info.get("currentPrice") or info.get("regularMarketPrice")
    if current_price is None:
        return None

    df: Any = None
    with suppress(Exception):
        df = stock.upgrades_downgrades

    if df is None or isinstance(df, dict) or (isinstance(df, pd.DataFrame) and df.empty):
        return None

    ratings_df = cast(pd.DataFrame, df).copy()

    try:
        ratings_df.index = pd.to_datetime(ratings_df.index, utc=True)
        cutoff_date = datetime.now(UTC) - timedelta(days=days)
        recent_ratings = ratings_df[ratings_df.index >= cutoff_date]

        if recent_ratings.empty:
            return None

        upside_pct = ((recent_ratings["currentPriceTarget"] - current_price) / current_price * 100).round(2)
        median_upside_pct = float(upside_pct.median())

        return {
            "median_upside_pct": median_upside_pct,
            "ratings": recent_ratings.to_dict("records"),
        }
    except Exception:
        return None


class StockIndicator:
    """Fetches and calculates technical and fundamental indicators for a stock."""

    def __init__(self, ticker: str):
        self.ticker = yf.Ticker(_normalize_yahoo_ticker(ticker))
        self._info: dict[str, Any] = {}
        self._history_cache: dict[str, pd.DataFrame] = {}
        self._parsed_ratings: dict[str, Any] | None | object = _UNSET

    # --- Time Utilities ---

    @staticmethod
    def _now_ny() -> datetime:
        return datetime.now(tz=NY_TZ)

    @staticmethod
    def _infer_session(now_ny: datetime) -> str:
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
        if session not in _SESSION_WINDOWS:
            return None

        start_time, end_time = _SESSION_WINDOWS[session]
        current_date = now_ny.date()
        return (
            datetime.combine(current_date, start_time, tzinfo=NY_TZ),
            datetime.combine(current_date, end_time, tzinfo=NY_TZ),
        )

    @staticmethod
    def _index_to_ny(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
        return index.tz_convert(NY_TZ) if index.tz else index.tz_localize(NY_TZ)

    @staticmethod
    def _close_series(hist: pd.DataFrame) -> pd.Series | None:
        if hist.empty or "Close" not in hist:
            return None
        return hist["Close"].dropna()

    # --- Data Fetching ---

    def _history(
        self,
        *,
        period: str,
        interval: str | None = None,
        prepost: bool = False,
    ) -> pd.DataFrame:
        cache_key = f"{period}|{interval or ''}|prepost={prepost}"
        if cache_key in self._history_cache:
            return self._history_cache[cache_key]

        try:
            kwargs: dict[str, Any] = {"period": period, "prepost": prepost}
            if interval:
                kwargs["interval"] = interval
            hist = self.ticker.history(**kwargs)
            if not isinstance(hist, pd.DataFrame):
                hist = pd.DataFrame()
        except Exception:
            hist = pd.DataFrame()

        self._history_cache[cache_key] = hist
        return hist

    @property
    def info(self) -> dict[str, Any]:
        """Fetch and cache info to avoid repeated network calls."""
        if not self._info:
            with suppress(Exception):
                self._info = self.ticker.info or {}
        return self._info

    @property
    def _market_state(self) -> str:
        return str(self.info.get("marketState") or "").upper()

    # --- Price Resolution ---

    def _extract_session_close(self, hist: pd.DataFrame, window: tuple[datetime, datetime] | None) -> float | None:
        """Extract the last close price from history, optionally scoped to a session window."""
        close_series = self._close_series(hist)
        if close_series is None:
            return None

        try:
            if window:
                idx_ny = self._index_to_ny(hist.index)
                start, end = window
                scoped = hist.loc[(idx_ny >= start) & (idx_ny < end)]
                scoped_close = self._close_series(scoped)
                if scoped_close is not None and not scoped_close.empty:
                    return _round(float(scoped_close.iloc[-1]))

            return _round(float(close_series.iloc[-1]))
        except Exception:
            return None

    def _last_intraday_price(self) -> float | None:
        """Best-effort intraday close price (fallback when `info` is missing)."""
        now_ny = self._now_ny()
        session = self._market_state or self._infer_session(now_ny)
        window = self._session_window(now_ny, session)

        for interval in _INTRADAY_PRICE_INTERVALS:
            hist = self._history(period="1d", interval=interval, prepost=True)
            if (price := self._extract_session_close(hist, window)) is not None:
                return price
        return None

    def _daily_close_series(self) -> pd.Series | None:
        hist = self._history(period=_DAILY_HISTORY_PERIOD, interval=_DAILY_INTERVAL)
        return self._close_series(hist)

    def _last_close(self) -> float | None:
        """Best-effort daily close price."""
        close_series = self._daily_close_series()
        if close_series is None or close_series.empty:
            return None

        with suppress(Exception):
            return _round(float(close_series.iloc[-1]))
        return None

    def _previous_close_from_history(self) -> float | None:
        """Best-effort previous close from daily history."""
        close_series = self._daily_close_series()
        if close_series is None or close_series.empty:
            return None

        with suppress(Exception):
            if len(close_series) >= 2:
                return _round(float(close_series.iloc[-2]))
            return _round(float(close_series.iloc[-1]))
        return None

    def _select_realtime_price_from_info(self) -> float | None:
        """Pick the best available price from Yahoo `info`, including pre/post market."""
        info = self.info
        candidates: list[tuple[int, float]] = []

        for price_key, time_key in _PRICE_TIME_KEYS:
            price = _safe_float(info.get(price_key))
            if price is None:
                continue

            try:
                timestamp = int(info.get(time_key) or 0)
            except (TypeError, ValueError):
                timestamp = 0
            candidates.append((timestamp, price))

        if candidates and any(ts > 0 for ts, _ in candidates):
            _, price = max(candidates, key=lambda item: item[0])
            return _round(price)

        preferred_key = _SESSION_PRICE_KEYS.get(self._market_state)
        for key in (preferred_key, *_PRICE_FALLBACK_ORDER):
            if not key:
                continue
            if (price := _safe_float(info.get(key))) is not None:
                return _round(price)

        return None

    @property
    def price(self) -> float | None:
        """Get latest price based on market state (Pre, Regular, Post)."""
        if (price := self._select_realtime_price_from_info()) is not None:
            return price
        if (price := _safe_float(self.info.get("currentPrice"))) is not None:
            return _round(price)
        return self._last_intraday_price() or self._last_close()

    def _get_previous_close(self) -> float | None:
        """Get appropriate baseline price for calculating change."""
        if (previous_close := _safe_float(self.info.get("regularMarketPreviousClose"))) is not None:
            return _round(previous_close)
        return self._previous_close_from_history()

    # --- Change Calculations ---

    @property
    def change(self) -> float | None:
        """Calculate change from previous close."""
        current_price = self.price
        previous_close = self._get_previous_close()
        if current_price is None or previous_close is None:
            return None
        return _round(current_price - previous_close)

    @property
    def change_percent(self) -> float | None:
        """Calculate percentage change from previous close."""
        current_price = self.price
        previous_close = self._get_previous_close()
        if current_price is None or previous_close is None or previous_close == 0:
            return None
        return _round(((current_price - previous_close) / previous_close) * 100)

    # --- Fundamental Indicators ---

    @property
    def market_cap(self) -> float | None:
        """Raw market cap in dollars."""
        return _safe_float(self.info.get("marketCap"))

    @property
    def pe(self) -> float | None:
        """Trailing P/E ratio."""
        return _round(_safe_float(self.info.get("trailingPE")))

    @property
    def pe_forward(self) -> float | None:
        """Forward P/E ratio."""
        return _round(_safe_float(self.info.get("forwardPE")))

    @property
    def peg(self) -> float | None:
        """PEG ratio."""
        return _round(_safe_float(self.info.get("trailingPegRatio")))

    @property
    def debt_to_equity(self) -> float | None:
        """Debt-to-equity percentage from Yahoo Finance."""
        return _round(_safe_float(self.info.get("debtToEquity")))

    @property
    def free_cash_flow(self) -> float | None:
        """Free cash flow converted to the quote currency when needed."""
        free_cash_flow = _safe_float(self.info.get("freeCashflow"))
        if free_cash_flow is None:
            return None

        financial_currency = str(self.info.get("financialCurrency") or "").upper()
        quote_currency = str(self.info.get("currency") or "").upper()

        if not financial_currency or not quote_currency or financial_currency == quote_currency:
            return free_cash_flow

        conversion_rate = _fx_rate(financial_currency, quote_currency)
        if conversion_rate is None:
            return None
        return free_cash_flow * conversion_rate

    @property
    def revenue_growth(self) -> float | None:
        """Revenue growth percentage."""
        revenue_growth = _safe_float(self.info.get("revenueGrowth"))
        if revenue_growth is None:
            return None
        return _round(revenue_growth * 100)

    @property
    def earning_direction(self) -> str | None:
        """Direction of expected earnings change based on P/E ratios."""
        trailing_pe = _safe_float(self.info.get("trailingPE"))
        forward_pe = _safe_float(self.info.get("forwardPE"))
        if trailing_pe is None or forward_pe is None:
            return None
        return "Increase" if trailing_pe > forward_pe else "Decrease"

    @property
    def gross_margin(self) -> float | None:
        """Gross margin percentage."""
        gross_margins = _safe_float(self.info.get("grossMargins"))
        if gross_margins is None:
            return None
        return _round(gross_margins * 100)

    # --- Technical Indicators ---

    def _calculate_rsi(self, days: int) -> float | None:
        """Calculate RSI for the given period."""
        try:
            hist = self._history(period=f"{days + 10}d")
            close_series = self._close_series(hist)
            if close_series is None or len(close_series) < days + 1:
                return None

            deltas = close_series.diff()
            gains = deltas.where(deltas > 0, 0.0)
            losses = -deltas.where(deltas < 0, 0.0)

            avg_gain = float(gains.rolling(window=days).mean().iloc[-1])
            avg_loss = float(losses.rolling(window=days).mean().iloc[-1])

            if avg_loss == 0:
                return 100.0

            rs = avg_gain / avg_loss
            return _round(100 - (100 / (1 + rs)))
        except Exception:
            return None

    def _calculate_ema_change_percent(self, days: int) -> float | None:
        """Calculate percentage change from EMA."""
        try:
            hist = self._history(period=f"{days + 30}d")
            close_series = self._close_series(hist)
            current_price = self.price
            if close_series is None or len(close_series) < days or current_price is None:
                return None

            ema = float(close_series.ewm(span=days, adjust=False).mean().iloc[-1])
            if ema == 0:
                return None

            return _round(((current_price / ema) - 1) * 100)
        except Exception:
            return None

    def _period_baseline_close(self, start_date: date, history_period: str) -> float | None:
        """Get period baseline close: prior-session close, else first close on/after start."""
        hist = self._history(period=history_period, interval="1d")
        close_series = self._close_series(hist)
        if close_series is None or close_series.empty:
            return None

        try:
            idx_ny = self._index_to_ny(close_series.index)
            before_start = close_series.loc[idx_ny.date < start_date]
            if not before_start.empty:
                return float(before_start.iloc[-1])

            on_or_after_start = close_series.loc[idx_ny.date >= start_date]
            if on_or_after_start.empty:
                return None
            return float(on_or_after_start.iloc[0])
        except Exception:
            return None

    def _calculate_period_return_percent(self, start_date: date, history_period: str) -> float | None:
        """Calculate return percent from the close before `start_date` to current price."""
        current_price = self.price
        if current_price is None:
            return None

        baseline_close = self._period_baseline_close(start_date, history_period)
        if baseline_close is None or baseline_close == 0:
            return None

        return _round(((current_price / baseline_close) - 1) * 100)

    @property
    def rsi(self) -> float | None:
        """Relative Strength Index (RSI)."""
        return self._calculate_rsi(DEFAULT_RSI_PERIOD)

    @property
    def one_month_change_percent(self) -> float | None:
        return self._period_change_percent("one_month_change_percent")

    @property
    def three_month_change_percent(self) -> float | None:
        return self._period_change_percent("three_month_change_percent")

    @property
    def six_month_change_percent(self) -> float | None:
        return self._period_change_percent("six_month_change_percent")

    @property
    def one_year_change_percent(self) -> float | None:
        return self._period_change_percent("one_year_change_percent")

    def _period_change_percent(self, key: str) -> float | None:
        months, history_period = PERIOD_RETURN_WINDOWS[key]
        today_ny = self._now_ny().date()
        return self._calculate_period_return_percent(
            _subtract_months(today_ny, months),
            history_period,
        )

    @property
    def mtd_change_percent(self) -> float | None:
        today_ny = self._now_ny().date()
        month_start = date(today_ny.year, today_ny.month, 1)
        return self._calculate_period_return_percent(month_start, "3mo")

    @property
    def ytd_change_percent(self) -> float | None:
        today_ny = self._now_ny().date()
        year_start = date(today_ny.year, 1, 1)
        if (hist_ytd := self._calculate_period_return_percent(year_start, "2y")) is not None:
            return hist_ytd

        ytd_return = _safe_float(self.info.get("ytdReturn"))
        return _round(ytd_return) if ytd_return is not None else None

    # --- Analyst Ratings ---

    @property
    def _ratings_payload(self) -> dict[str, Any] | None:
        if self._parsed_ratings is _UNSET:
            self._parsed_ratings = parse_ratings(self.ticker)
        return self._parsed_ratings if isinstance(self._parsed_ratings, dict) else None

    @property
    def median_upside(self) -> float | None:
        """Median analyst upside from recent ratings."""
        ratings = self._ratings_payload
        return _safe_float(ratings.get("median_upside_pct")) if ratings else None

    @property
    def ratings(self) -> list[dict[str, Any]] | None:
        """Raw analyst rating records."""
        ratings = self._ratings_payload
        if not ratings:
            return None
        value = ratings.get("ratings")
        return value if isinstance(value, list) else None

    # --- Aggregate ---

    def get_all_indicators(self) -> dict[str, Any]:
        """Get all available indicators as a dictionary."""
        return {
            "price": self.price,
            "change": self.change,
            "change_percent": self.change_percent,
            "market_cap": self.market_cap,
            "pe": self.pe,
            "pe_forward": self.pe_forward,
            "peg": self.peg,
            "debt_to_equity": self.debt_to_equity,
            "free_cash_flow": self.free_cash_flow,
            "revenue_growth": self.revenue_growth,
            "earning_direction": self.earning_direction,
            "rsi": self.rsi,
            "gross_margin": self.gross_margin,
            "one_month_change_percent": self.one_month_change_percent,
            "three_month_change_percent": self.three_month_change_percent,
            "six_month_change_percent": self.six_month_change_percent,
            "one_year_change_percent": self.one_year_change_percent,
            "mtd_change_percent": self.mtd_change_percent,
            "ytd_change_percent": self.ytd_change_percent,
            "median_upside": self.median_upside,
        }
