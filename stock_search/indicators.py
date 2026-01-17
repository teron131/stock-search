from contextlib import suppress
from datetime import UTC, datetime, timedelta
import logging
from typing import Any, cast

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

MARKET_CAP_UNITS = [
    (1e12, "T"),
    (1e9, "B"),
    (1e6, "M"),
    (1e3, "K"),
]


def parse_ratings(ticker: str | yf.Ticker, days: int = DEFAULT_RATINGS_LOOKBACK_DAYS) -> dict | None:
    """Parse analyst ratings for a ticker and calculate upside metrics.

    Args:
        ticker: Ticker string or yf.Ticker instance
        days: Number of days to look back for ratings

    Returns:
        Dictionary with median_upside_pct and raw ratings data, or None if unavailable
    """
    stock = ticker if isinstance(ticker, yf.Ticker) else yf.Ticker(ticker)
    current_price = stock.info.get("currentPrice")

    # yfinance can return None, or sometimes a dict if something goes wrong, though usually DataFrame
    df: Any = stock.upgrades_downgrades

    if df is None or isinstance(df, dict) or (isinstance(df, pd.DataFrame) and df.empty) or current_price is None:
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
        self._info: dict = {}

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

    @property
    def price(self) -> float | None:
        """Get latest price based on market state (Pre, Regular, Post)."""
        info = self.info

        # 1. Prefer explicit 'currentPrice' from Yahoo if available
        if (p := info.get("currentPrice")) is not None:
            return _round(p)

        # 2. Fallback to manual logic based on market state
        state = self._market_state
        price = None

        if state == MARKET_STATE_PRE:
            price = info.get("preMarketPrice") or info.get("regularMarketPrice")
        elif state == MARKET_STATE_REGULAR:
            price = info.get("regularMarketPrice") or info.get("preMarketPrice")
        elif state in (MARKET_STATE_POST, MARKET_STATE_POSTPOST, MARKET_STATE_CLOSED):
            price = info.get("postMarketPrice") or info.get("regularMarketPrice")

        # Fallback for unknown states or missing data
        if price is None:
            price = info.get("regularMarketPrice") or info.get("postMarketPrice") or info.get("preMarketPrice")

        return _round(price)

    def _get_previous_close(self) -> float | None:
        """Get appropriate baseline price for calculating change."""
        info = self.info

        # Use Yahoo's explicit previous close if available
        if (pc := info.get("regularMarketPreviousClose")) is not None:
            return _round(pc)

        state = self._market_state
        if state == MARKET_STATE_PRE:
            return _round(info.get("regularMarketPrice"))

        if state in (MARKET_STATE_POST, MARKET_STATE_POSTPOST, MARKET_STATE_CLOSED) and info.get("postMarketPrice"):
            return _round(info.get("regularMarketPrice"))

        return _round(info.get("regularMarketPreviousClose"))

    @property
    def change(self) -> float | None:
        """Calculate change from previous close."""
        # 1. Prefer explicit field from Yahoo
        if (c := self.info.get("regularMarketChange")) is not None:
            return _round(c)

        # 2. Fallback to calculation
        if (current_price := self.price) is None or (previous_close := self._get_previous_close()) is None:
            return None
        return _round(current_price - previous_close)

    @property
    def change_percent(self) -> float | None:
        """Calculate percentage change from previous close."""
        # 1. Prefer explicit field from Yahoo
        if (cp := self.info.get("regularMarketChangePercent")) is not None:
            return _round(cp)

        # 2. Fallback to calculation
        if (current_price := self.price) is None or (previous_close := self._get_previous_close()) is None or previous_close == 0:
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
