from contextlib import suppress
from datetime import UTC, datetime, time, timedelta
import logging
from typing import Any, cast
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# Constants
DEFAULT_RATINGS_LOOKBACK_DAYS = 90
DEFAULT_RSI_PERIOD = 14

MARKET_STATE_PRE = "PRE"
MARKET_STATE_REGULAR = "REGULAR"
MARKET_STATE_POST = "POST"
MARKET_STATE_POSTPOST = "POSTPOST"
MARKET_STATE_CLOSED = "CLOSED"

NY_TZ = ZoneInfo("America/New_York")

# Approximate US equities hours (NY time). Used only as a fallback when `info.marketState`
# is missing/unreliable.
_SESSION_PRE_START = time(4, 0)
_SESSION_REGULAR_START = time(9, 30)
_SESSION_REGULAR_END = time(16, 0)
_SESSION_POST_END = time(20, 0)

MARKET_CAP_UNITS = [
    (1e12, "T"),
    (1e9, "B"),
    (1e6, "M"),
    (1e3, "K"),
]


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

    # yfinance can return None, or sometimes a dict if something goes wrong, though usually DataFrame
    df: Any = None
    with suppress(Exception):
        df = stock.upgrades_downgrades

    if df is None or isinstance(df, dict) or (isinstance(df, pd.DataFrame) and df.empty):
        return None

    # Enforce DataFrame type for subsequent operations
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


def _round(value: float | None, decimals: int = 2) -> float | None:
    """Round a value if not None."""
    return round(float(value), decimals) if value is not None else None


class StockIndicator:
    """Fetches and calculates technical and fundamental indicators for a stock."""

    def __init__(self, ticker: str):
        self.ticker = yf.Ticker(ticker)
        self._info: dict[str, Any] = {}
        self._history_cache: dict[str, pd.DataFrame] = {}

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
        if session == MARKET_STATE_PRE:
            return (
                datetime.combine(d, _SESSION_PRE_START, tzinfo=NY_TZ),
                datetime.combine(d, _SESSION_REGULAR_START, tzinfo=NY_TZ),
            )
        if session == MARKET_STATE_REGULAR:
            return (
                datetime.combine(d, _SESSION_REGULAR_START, tzinfo=NY_TZ),
                datetime.combine(d, _SESSION_REGULAR_END, tzinfo=NY_TZ),
            )
        if session in (MARKET_STATE_POST, MARKET_STATE_POSTPOST):
            return (
                datetime.combine(d, _SESSION_REGULAR_END, tzinfo=NY_TZ),
                datetime.combine(d, _SESSION_POST_END, tzinfo=NY_TZ),
            )
        return None

    @staticmethod
    def _index_to_ny(idx) -> Any:
        # pandas Index typing here is too loose for pyright
        return idx.tz_convert(NY_TZ) if getattr(idx, "tz", None) else idx.tz_localize(NY_TZ)  # type: ignore[attr-defined]

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
            df = (
                self.ticker.history(
                    period=period,
                    interval=interval,
                    prepost=prepost,
                )
                if interval
                else self.ticker.history(period=period, prepost=prepost)
            )
            if not isinstance(df, pd.DataFrame):
                df = pd.DataFrame()
        except Exception:
            df = pd.DataFrame()

        self._history_cache[key] = df
        return df

    def _last_intraday_price(self) -> float | None:
        """Best-effort intraday close price (fallback when `info` is missing)."""
        # Use extended-hours candles so pre/post market is captured when present.
        # Some tickers intermittently return empty data for 1m; fall back to coarser intervals.
        now_ny = self._now_ny()
        target_session = self._market_state or self._infer_session(now_ny)
        window = self._session_window(now_ny, target_session)

        def pick_last_close_for_session(hist: pd.DataFrame) -> float | None:
            if hist.empty or "Close" not in hist:
                return None

            try:
                idx_ny = self._index_to_ny(hist.index)
            except Exception:
                idx_ny = hist.index

            try:
                if window:
                    start, end = window
                    mask = (idx_ny >= start) & (idx_ny < end)
                    scoped = hist.loc[mask]
                    if not scoped.empty:
                        return _round(float(scoped["Close"].iloc[-1]))

                return _round(float(hist["Close"].iloc[-1]))
            except Exception:
                return None

        for interval in ("1m", "5m", "15m"):
            hist = self._history(period="1d", interval=interval, prepost=True)
            if (p := pick_last_close_for_session(hist)) is not None:
                return p
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

    @property
    def info(self) -> dict:
        """Fetch and cache info to avoid repeated network calls."""
        if not self._info:
            with suppress(Exception):
                self._info = self.ticker.info or {}
        return self._info

    @property
    def _market_state(self) -> str:
        """Get the standardized market state."""
        return str(self.info.get("marketState") or "").upper()

    def _select_realtime_price_from_info(self) -> float | None:
        """Pick the best available price from Yahoo `info`, including pre/post market.

        Yahoo sometimes mislabels `marketState` or leaves it blank; timestamps are more reliable.
        """
        info = self.info

        candidates: list[tuple[int, float]] = []

        def add_candidate(price_key: str, time_key: str) -> None:
            price = info.get(price_key)
            if price is None:
                return
            t = info.get(time_key) or 0
            try:
                candidates.append((int(t), float(price)))
            except (TypeError, ValueError):
                return

        add_candidate("preMarketPrice", "preMarketTime")
        add_candidate("regularMarketPrice", "regularMarketTime")
        add_candidate("postMarketPrice", "postMarketTime")

        if candidates and any(ts > 0 for ts, _ in candidates):
            # Prefer the most recently updated session.
            _, price = max(candidates, key=lambda x: x[0])
            return _round(price)

        # Fallback: prefer by marketState, then any available.
        state = self._market_state

        prefer_key = None
        if state == MARKET_STATE_PRE:
            prefer_key = "preMarketPrice"
        elif state in (MARKET_STATE_POST, MARKET_STATE_POSTPOST, MARKET_STATE_CLOSED):
            prefer_key = "postMarketPrice"
        elif state == MARKET_STATE_REGULAR:
            prefer_key = "regularMarketPrice"

        keys = [
            prefer_key,
            "regularMarketPrice",
            "postMarketPrice",
            "preMarketPrice",
        ]

        for key in keys:
            if not key:
                continue
            if (p := info.get(key)) is not None:
                return _round(p)

        return None

    @property
    def price(self) -> float | None:
        """Get latest price based on market state (Pre, Regular, Post)."""
        info = self.info

        # 1) Prefer a timestamp-aware selection from info (captures pre/post market correctly).
        if (p := self._select_realtime_price_from_info()) is not None:
            return p

        # 2) Fallback to explicit 'currentPrice' from Yahoo if available
        if (p := info.get("currentPrice")) is not None:
            return _round(p)

        # 3) Last-resort fallback: intraday close (with extended hours), then daily close
        return self._last_intraday_price() or self._last_close()

    def _price_for_change(self) -> float | None:
        """Return the price that should drive change/change_percent.

        During PRE/POST/CLOSED, this should reflect pre/post market when available.
        """
        return self.price

    def _get_previous_close(self) -> float | None:
        """Get appropriate baseline price for calculating change."""
        info = self.info

        # Use Yahoo's explicit previous close if available
        if (pc := info.get("regularMarketPreviousClose")) is not None:
            return _round(pc)

        return self._previous_close_from_history()

    @property
    def change(self) -> float | None:
        """Calculate change from previous close."""
        # Use the same baseline for regular + pre/post market: previous close.
        if (current_price := self._price_for_change()) is None or (previous_close := self._get_previous_close()) is None:
            return None
        return _round(current_price - previous_close)

    @property
    def change_percent(self) -> float | None:
        """Calculate percentage change from previous close."""
        if (current_price := self._price_for_change()) is None or (previous_close := self._get_previous_close()) is None or previous_close == 0:
            return None
        return _round(((current_price - previous_close) / previous_close) * 100)

    @property
    def market_cap(self) -> float | None:
        """Raw market cap in dollars (no formatting).

        Formatting is handled at display time (UI) to avoid rounding the underlying data.
        """
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
        if not (trailing_pe := self.info.get("trailingPE")) or not (forward_pe := self.info.get("forwardPE")):
            return None
        return "Increase" if trailing_pe > forward_pe else "Decrease"

    @property
    def rsi(self, days: int = DEFAULT_RSI_PERIOD) -> float | None:
        """Relative Strength Index (RSI)."""
        try:
            hist = self.ticker.history(period=f"{days + 10}d")
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

    @property
    def gross_margin(self) -> float | None:
        """Gross margin percentage."""
        if (gross_margins := self.info.get("grossMargins")) is not None:
            return _round(gross_margins * 100)
        return None

    def _calculate_change_percent(self, days: int) -> float | None:
        """Calculate percentage change from EMA."""
        try:
            hist = self.ticker.history(period=f"{days + 30}d")
            if hist.empty or len(hist) < days or (current_price := self.price) is None:
                return None
            ema = float(hist["Close"].ewm(span=days, adjust=False).mean().iloc[-1])
            if ema == 0:
                return None
            return _round(((current_price / ema) - 1) * 100)
        except Exception:
            return None

    def _get_day_change_percent(self, days: int, key: str) -> float | None:
        """Get day change percent from info or calculate it."""
        if (change := self.info.get(key)) is not None:
            return _round(change * 100)
        return self._calculate_change_percent(days)

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
    def median_upside(self) -> float | None:
        """Median analyst upside from recent ratings."""
        ratings = parse_ratings(self.ticker)
        return ratings.get("median_upside_pct") if ratings else None

    @property
    def ratings(self) -> list[dict] | None:
        """Raw analyst rating records."""
        ratings = parse_ratings(self.ticker)
        return ratings.get("ratings") if ratings else None

    def get_all_indicators(self) -> dict:
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
            "median_upside": self.median_upside,
        }
