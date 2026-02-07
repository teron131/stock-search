from contextlib import suppress
from datetime import UTC, date, datetime, time, timedelta
import logging
from typing import Any, cast
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# --- Configuration ---
DEFAULT_RATINGS_LOOKBACK_DAYS = 90
DEFAULT_RSI_PERIOD = 14

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

# --- Formatting ---
MARKET_CAP_UNITS = [
    (1e12, "T"),
    (1e9, "B"),
    (1e6, "M"),
    (1e3, "K"),
]

# --- Price Keys by Session ---
_SESSION_PRICE_KEYS: dict[str, str] = {
    MARKET_STATE_PRE: "preMarketPrice",
    MARKET_STATE_POST: "postMarketPrice",
    MARKET_STATE_POSTPOST: "postMarketPrice",
    MARKET_STATE_CLOSED: "postMarketPrice",
    MARKET_STATE_REGULAR: "regularMarketPrice",
}

_PRICE_FALLBACK_ORDER = ("regularMarketPrice", "postMarketPrice", "preMarketPrice")


def _round(value: float | None, decimals: int = 2) -> float | None:
    """Round a value if not None."""
    return round(float(value), decimals) if value is not None else None


def parse_ratings(
    ticker: str | yf.Ticker,
    days: int = DEFAULT_RATINGS_LOOKBACK_DAYS,
) -> dict | None:
    """Parse analyst ratings for a ticker and calculate upside metrics.

    Args:
        ticker: Ticker string or yf.Ticker instance
        days: Number of days to look back for ratings

    Returns:
        Dictionary with median_upside_pct and raw ratings data, or None if unavailable
    """
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

    df = cast(pd.DataFrame, df).copy()

    try:
        df.index = pd.to_datetime(df.index, utc=True)
        cutoff_date = datetime.now(UTC) - timedelta(days=days)
        recent_ratings = df[df.index >= cutoff_date]

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
        self.ticker = yf.Ticker(ticker)
        self._info: dict[str, Any] = {}
        self._history_cache: dict[str, pd.DataFrame] = {}

    # --- Time Utilities ---

    @staticmethod
    def _now_ny() -> datetime:
        return datetime.now(tz=NY_TZ)

    @staticmethod
    def _infer_session(now_ny: datetime) -> str:
        if now_ny.weekday() >= 5:
            return MARKET_STATE_CLOSED

        t = now_ny.timetz().replace(tzinfo=None)
        if _SESSION_PRE_START <= t < _SESSION_REGULAR_START:
            return MARKET_STATE_PRE
        if _SESSION_REGULAR_START <= t < _SESSION_REGULAR_END:
            return MARKET_STATE_REGULAR
        if _SESSION_REGULAR_END <= t < _SESSION_POST_END:
            return MARKET_STATE_POST
        return MARKET_STATE_CLOSED

    @staticmethod
    def _session_window(now_ny: datetime, session: str) -> tuple[datetime, datetime] | None:
        d = now_ny.date()
        windows = {
            MARKET_STATE_PRE: (_SESSION_PRE_START, _SESSION_REGULAR_START),
            MARKET_STATE_REGULAR: (_SESSION_REGULAR_START, _SESSION_REGULAR_END),
            MARKET_STATE_POST: (_SESSION_REGULAR_END, _SESSION_POST_END),
            MARKET_STATE_POSTPOST: (_SESSION_REGULAR_END, _SESSION_POST_END),
        }
        if session not in windows:
            return None
        start_time, end_time = windows[session]
        return (
            datetime.combine(d, start_time, tzinfo=NY_TZ),
            datetime.combine(d, end_time, tzinfo=NY_TZ),
        )

    @staticmethod
    def _index_to_ny(idx: pd.DatetimeIndex) -> pd.DatetimeIndex:
        return idx.tz_convert(NY_TZ) if idx.tz else idx.tz_localize(NY_TZ)

    # --- Data Fetching ---

    def _history(
        self,
        *,
        period: str,
        interval: str | None = None,
        prepost: bool = False,
    ) -> pd.DataFrame:
        key = f"{period}|{interval or ''}|prepost={prepost}"
        if key in self._history_cache:
            return self._history_cache[key]

        try:
            kwargs: dict[str, Any] = {"period": period, "prepost": prepost}
            if interval:
                kwargs["interval"] = interval
            df = self.ticker.history(**kwargs)
            if not isinstance(df, pd.DataFrame):
                df = pd.DataFrame()
        except Exception:
            df = pd.DataFrame()

        self._history_cache[key] = df
        return df

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

    def _last_intraday_price(self) -> float | None:
        """Best-effort intraday close price (fallback when `info` is missing)."""
        now_ny = self._now_ny()
        target_session = self._market_state or self._infer_session(now_ny)
        window = self._session_window(now_ny, target_session)

        for interval in ("1m", "5m", "15m"):
            hist = self._history(period="1d", interval=interval, prepost=True)
            if (p := self._extract_session_close(hist, window)) is not None:
                return p
        return None

    def _extract_session_close(self, hist: pd.DataFrame, window: tuple[datetime, datetime] | None) -> float | None:
        """Extract the last close price from history, optionally scoped to a session window."""
        if hist.empty or "Close" not in hist:
            return None
        try:
            idx_ny = self._index_to_ny(hist.index)
            if window:
                start, end = window
                mask = (idx_ny >= start) & (idx_ny < end)
                scoped = hist.loc[mask]
                if not scoped.empty:
                    return _round(float(scoped["Close"].iloc[-1]))
            return _round(float(hist["Close"].iloc[-1]))
        except Exception:
            return None

    def _last_close(self) -> float | None:
        """Best-effort daily close price."""
        hist = self._history(period="5d", interval="1d")
        if hist.empty or "Close" not in hist:
            return None
        with suppress(Exception):
            return _round(float(hist["Close"].iloc[-1]))
        return None

    def _previous_close_from_history(self) -> float | None:
        """Best-effort previous close from daily history."""
        hist = self._history(period="5d", interval="1d")
        if hist.empty or "Close" not in hist:
            return None
        with suppress(Exception):
            closes = hist["Close"].dropna()
            if len(closes) >= 2:
                return _round(float(closes.iloc[-2]))
            if len(closes) == 1:
                return _round(float(closes.iloc[-1]))
        return None

    def _select_realtime_price_from_info(self) -> float | None:
        """Pick the best available price from Yahoo `info`, including pre/post market."""
        info = self.info
        candidates: list[tuple[int, float]] = []

        price_time_pairs = [
            ("preMarketPrice", "preMarketTime"),
            ("regularMarketPrice", "regularMarketTime"),
            ("postMarketPrice", "postMarketTime"),
        ]

        for price_key, time_key in price_time_pairs:
            price = info.get(price_key)
            if price is None:
                continue
            try:
                t = int(info.get(time_key) or 0)
                candidates.append((t, float(price)))
            except (TypeError, ValueError):
                continue

        # Prefer most recently updated session
        if candidates and any(ts > 0 for ts, _ in candidates):
            _, price = max(candidates, key=lambda x: x[0])
            return _round(price)

        # Fallback by market state
        prefer_key = _SESSION_PRICE_KEYS.get(self._market_state)
        for key in (prefer_key, *_PRICE_FALLBACK_ORDER):
            if key and (p := info.get(key)) is not None:
                return _round(p)

        return None

    @property
    def price(self) -> float | None:
        """Get latest price based on market state (Pre, Regular, Post)."""
        if (p := self._select_realtime_price_from_info()) is not None:
            return p
        if (p := self.info.get("currentPrice")) is not None:
            return _round(p)
        return self._last_intraday_price() or self._last_close()

    def _get_previous_close(self) -> float | None:
        """Get appropriate baseline price for calculating change."""
        if (pc := self.info.get("regularMarketPreviousClose")) is not None:
            return _round(pc)
        return self._previous_close_from_history()

    # --- Change Calculations ---

    @property
    def change(self) -> float | None:
        """Calculate change from previous close."""
        current = self.price
        previous = self._get_previous_close()
        if current is None or previous is None:
            return None
        return _round(current - previous)

    @property
    def change_percent(self) -> float | None:
        """Calculate percentage change from previous close."""
        current = self.price
        previous = self._get_previous_close()
        if current is None or previous is None or previous == 0:
            return None
        return _round(((current - previous) / previous) * 100)

    # --- Fundamental Indicators ---

    @property
    def market_cap(self) -> float | None:
        """Raw market cap in dollars."""
        if (market_cap := self.info.get("marketCap")) is None:
            return None
        try:
            return float(market_cap)
        except (TypeError, ValueError):
            return None

    @property
    def pe(self) -> float | None:
        """Trailing P/E ratio."""
        return _round(self.info.get("trailingPE"))

    @property
    def pe_forward(self) -> float | None:
        """Forward P/E ratio."""
        return _round(self.info.get("forwardPE"))

    @property
    def peg(self) -> float | None:
        """PEG ratio."""
        return _round(self.info.get("trailingPegRatio"))

    @property
    def earning_direction(self) -> str | None:
        """Direction of expected earnings change based on P/E ratios."""
        trailing_pe = self.info.get("trailingPE")
        forward_pe = self.info.get("forwardPE")
        if not trailing_pe or not forward_pe:
            return None
        return "Increase" if trailing_pe > forward_pe else "Decrease"

    @property
    def gross_margin(self) -> float | None:
        """Gross margin percentage."""
        if (gross_margins := self.info.get("grossMargins")) is not None:
            return _round(gross_margins * 100)
        return None

    # --- Technical Indicators ---

    @property
    def rsi(self) -> float | None:
        """Relative Strength Index (RSI)."""
        return self._calculate_rsi(DEFAULT_RSI_PERIOD)

    def _calculate_rsi(self, days: int) -> float | None:
        """Calculate RSI for the given period."""
        try:
            hist = self._history(period=f"{days + 10}d")
            if hist.empty or len(hist) < days + 1:
                return None

            deltas = hist["Close"].diff()
            gains = deltas.where(deltas > 0, 0)
            losses = -deltas.where(deltas < 0, 0)

            avg_gain = float(pd.Series(gains).rolling(window=days).mean().iloc[-1])
            avg_loss = float(pd.Series(losses).rolling(window=days).mean().iloc[-1])

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
            if hist.empty or len(hist) < days or (current_price := self.price) is None:
                return None
            ema = float(hist["Close"].ewm(span=days, adjust=False).mean().iloc[-1])
            if ema == 0:
                return None
            return _round(((current_price / ema) - 1) * 100)
        except Exception:
            return None

    def _get_day_change_percent(self, days: int, info_key: str) -> float | None:
        """Get day change percent from info or calculate it."""
        if (change := self.info.get(info_key)) is not None:
            return _round(change * 100)
        return self._calculate_ema_change_percent(days)

    def _calculate_period_return_percent(self, start_date: date, history_period: str) -> float | None:
        """Calculate return percent from the close before `start_date` to current price."""
        current_price = self.price
        if current_price is None:
            return None

        hist = self._history(period=history_period, interval="1d")
        if hist.empty or "Close" not in hist:
            return None

        try:
            idx_ny = self._index_to_ny(hist.index)
            close_series = hist["Close"]

            # Prefer the prior session close before the period start.
            before_start = close_series.loc[idx_ny.date < start_date]
            start_value = before_start.iloc[-1] if not before_start.empty else None

            # Fallback when no prior session is present in the requested history window.
            if start_value is None:
                on_or_after_start = close_series.loc[idx_ny.date >= start_date]
                if on_or_after_start.empty:
                    return None
                start_value = on_or_after_start.iloc[0]

            start_price = float(start_value)
            if start_price == 0.0:
                return None
            return _round(((current_price / start_price) - 1) * 100)
        except Exception:
            return None

    @property
    def twenty_day_change_percent(self) -> float | None:
        return self._get_day_change_percent(20, "twentyDayAverageChangePercent")

    @property
    def fifty_day_change_percent(self) -> float | None:
        return self._get_day_change_percent(50, "fiftyDayAverageChangePercent")

    @property
    def one_hundred_day_change_percent(self) -> float | None:
        return self._get_day_change_percent(100, "oneHundredDayAverageChangePercent")

    @property
    def two_hundred_day_change_percent(self) -> float | None:
        return self._get_day_change_percent(200, "twoHundredDayAverageChangePercent")

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

        ytd = self.info.get("ytdReturn")
        if ytd is None:
            return None
        with suppress(TypeError, ValueError):
            return _round(float(ytd))
        return None

    # --- Analyst Ratings ---

    @property
    def median_upside(self) -> float | None:
        """Median analyst upside from recent ratings."""
        ratings = parse_ratings(self.ticker)
        return ratings.get("median_upside_pct") if ratings else None

    @property
    def ratings(self) -> list[dict] | None:
        """Raw analyst rating records."""
        ratings = parse_ratings(self.ticker)
        return ratings.get("ratings") if ratings else None

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
            "earning_direction": self.earning_direction,
            "rsi": self.rsi,
            "gross_margin": self.gross_margin,
            "twenty_day_change_percent": self.twenty_day_change_percent,
            "fifty_day_change_percent": self.fifty_day_change_percent,
            "one_hundred_day_change_percent": self.one_hundred_day_change_percent,
            "two_hundred_day_change_percent": self.two_hundred_day_change_percent,
            "mtd_change_percent": self.mtd_change_percent,
            "ytd_change_percent": self.ytd_change_percent,
            "median_upside": self.median_upside,
        }
