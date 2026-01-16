from contextlib import suppress
from datetime import UTC, datetime, timedelta
import logging

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
    df = stock.upgrades_downgrades

    if df is None or df.empty or current_price is None:
        return None

    df = df.copy()
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


def _round(value: float | None, decimals: int = 2) -> float | None:
    """Round a value if not None."""
    return round(value, decimals) if value is not None else None


def _format_with_sign(value: float | None, suffix: str = "") -> str | None:
    """Format a numeric value with +/- sign and optional suffix."""
    if value is None:
        return None
    sign = "+" if value >= 0 else ""
    return f"{sign}{value:.2f}{suffix}"


class StockIndicator:
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
        """Get appropriate baseline price for calculating change.

        - Pre-Market: vs Regular Close (Yesterday) -> regularMarketPrice
        - Regular: vs Regular Close (Yesterday) -> regularMarketPreviousClose
        - Post-Market: vs Regular Close (Today) -> regularMarketPrice (if post price exists)
        """
        info = self.info
        state = self._market_state

        if state == MARKET_STATE_PRE:
            return _round(info.get("regularMarketPrice"))

        if state in (MARKET_STATE_POST, MARKET_STATE_POSTPOST, MARKET_STATE_CLOSED) and info.get("postMarketPrice"):
            return _round(info.get("regularMarketPrice"))

        return _round(info.get("regularMarketPreviousClose"))

    @property
    def change(self) -> float | None:
        """Calculate change from previous close based on current price source.

        Calculation: current_price - previous_close

        Returns:
            Absolute change in currency units (typically USD). Positive for gains, negative for losses.
            None if price data unavailable.
        """
        if (current_price := self.price) is None or (previous_close := self._get_previous_close()) is None:
            return None
        return round(current_price - previous_close, 2)

    @property
    def change_percent(self) -> float | None:
        """Calculate percentage change from previous close based on current price source.

        Calculation: ((current_price - previous_close) / previous_close) * 100

        Returns:
            Percentage change (0-100 scale). Positive for gains, negative for losses.
            None if price data unavailable or previous_close is zero.
        """
        if (current_price := self.price) is None or (previous_close := self._get_previous_close()) is None or previous_close == 0:
            return None
        return round(((current_price - previous_close) / previous_close) * 100, 2)

    @property
    def market_cap(self) -> str | None:
        """Format market cap as T/B/M/K with appropriate precision.

        Calculation: Divides raw market cap value by appropriate unit (trillion/billion/million/thousand)
        and formats with 3 decimal places.

        Returns:
            Formatted string (e.g., "1.234T", "567.890B") in currency units (typically USD).
            None if market cap unavailable.
        """
        if (market_cap := self.info.get("marketCap")) is None:
            return None
        for divisor, suffix in MARKET_CAP_UNITS:
            if market_cap >= divisor:
                return f"{market_cap / divisor:.3f}{suffix}"
        return f"{market_cap:.3f}"

    @property
    def pe(self) -> float | None:
        """Price-to-Earnings ratio (trailing P/E).

        Calculation: Market price per share / Earnings per share (trailing 12 months)

        Returns:
            P/E ratio (unitless). Lower values may indicate undervaluation.
            Typical range: 10-30 for most stocks. None if unavailable.
        """
        return _round(self.info.get("trailingPE"))

    @property
    def pe_forward(self) -> float | None:
        """Price-to-Earnings ratio (forward P/E).

        Calculation: Market price per share / Earnings per share (forward 12 months)

        Returns:
            P/E ratio (unitless). Lower values may indicate undervaluation.
            Typical range: 10-30 for most stocks. None if unavailable.
        """
        return _round(self.info.get("forwardPE"))

    @property
    def peg(self) -> float | None:
        """Price/Earnings to Growth ratio. < 2 indicates reasonable price, < 1 means undervalued. It is called 'trailing' but it is 5 years forward expected.

        Returns:
            PEG ratio (unitless).
        """
        return _round(self.info.get("trailingPegRatio"))

    @property
    def earning_direction(self) -> str | None:
        """Direction of expected earnings change based on P/E ratios."""
        if not (trailing_pe := self.info.get("trailingPE")) or not (forward_pe := self.info.get("forwardPE")):
            return None
        return "Increase" if trailing_pe > forward_pe else "Decrease"

    @property
    def rsi(self, days: int = DEFAULT_RSI_PERIOD) -> float | None:
        """Relative Strength Index (RSI, 14-period).

        Calculation:
        1. Calculate price changes (deltas) from closing prices
        2. Separate gains (positive deltas) and losses (negative deltas, made positive)
        3. Calculate average gain and average loss over 14-period rolling window
        4. RSI = 100 - (100 / (1 + RS)), where RS = avg_gain / avg_loss

        Returns:
            RSI value on 0-100 scale. 70+ indicates overbought conditions, 30- indicates oversold.
            None if insufficient historical data or calculation error.
        """
        try:
            hist = self.ticker.history(period=f"{days + 10}d")
            if hist.empty or len(hist) < days + 1:
                return None

            deltas = hist["Close"].diff()
            gains = deltas.where(deltas > 0, 0)
            losses = -deltas.where(deltas < 0, 0)

            avg_gain = float(gains.rolling(window=days).mean().iloc[-1])
            avg_loss = float(losses.rolling(window=days).mean().iloc[-1])

            if avg_loss == 0:
                return 100.0

            rs = avg_gain / avg_loss
            return round(100 - (100 / (1 + rs)), 2)
        except Exception:
            return None

    @property
    def gross_margin(self) -> float | None:
        """Gross margin as a percentage.

        Calculation: (Revenue - Cost of Goods Sold) / Revenue * 100

        Returns:
            Gross margin percentage on 0-100 scale. Higher values indicate better profitability.
            None if unavailable.
        """
        gross_margins = self.info.get("grossMargins")
        return _round(gross_margins * 100) if gross_margins is not None else None

    def _calculate_change_percent(self, days: int) -> float | None:
        """Calculate percentage change as (price / EMA - 1) * 100.

        Calculation:
        1. Calculate N-day Exponential Moving Average (EMA) of closing prices
        2. Percentage change = ((current_price / EMA) - 1) * 100

        Args:
            days: Number of days for EMA calculation

        Returns:
            Percentage change (0-100 scale). Positive if current price > EMA, negative if < EMA.
            None if insufficient data, price unavailable, or EMA is zero.
        """
        try:
            hist = self.ticker.history(period=f"{days + 30}d")
            if hist.empty or len(hist) < days or (current_price := self.price) is None:
                return None
            ema = float(hist["Close"].ewm(span=days, adjust=False).mean().iloc[-1])
            if ema == 0:
                return None
            return round(((current_price / ema) - 1) * 100, 2)
        except Exception:
            return None

    def _get_day_change_percent(self, days: int, key: str) -> float | None:
        """Get day change percent from info or calculate it.

        Args:
            days: Number of days for the change calculation
            key: Attribute name in info dict to check first

        Returns:
            Percentage change on 0-100 scale. None if unavailable.
        """
        if (change := self.info.get(key)) is not None:
            return round(change * 100, 2)
        return self._calculate_change_percent(days)

    @property
    def twenty_day_change_percent(self) -> float | None:
        """20-day percentage change.

        Calculation: Percentage change from 20-day EMA (or from yfinance info if available).

        Returns:
            Percentage change on 0-100 scale. None if unavailable.
        """
        return self._get_day_change_percent(20, "twentyDayAverageChangePercent")

    @property
    def fifty_day_change_percent(self) -> float | None:
        """50-day percentage change.

        Calculation: Percentage change from 50-day EMA (or from yfinance info if available).

        Returns:
            Percentage change on 0-100 scale. None if unavailable.
        """
        return self._get_day_change_percent(50, "fiftyDayAverageChangePercent")

    @property
    def one_hundred_day_change_percent(self) -> float | None:
        """100-day percentage change.

        Calculation: Percentage change from 100-day EMA (or from yfinance info if available).

        Returns:
            Percentage change on 0-100 scale. None if unavailable.
        """
        return self._get_day_change_percent(100, "oneHundredDayAverageChangePercent")

    @property
    def two_hundred_day_change_percent(self) -> float | None:
        """200-day percentage change.

        Calculation: Percentage change from 200-day EMA (or from yfinance info if available).

        Returns:
            Percentage change on 0-100 scale. None if unavailable.
        """
        return self._get_day_change_percent(200, "twoHundredDayAverageChangePercent")

    @property
    def median_upside(self) -> float | None:
        """Median analyst upside from recent ratings (last 90 days).

        Calculation: Median of (target_price - current_price) / current_price * 100
        across all analyst ratings from the last 90 days.

        Returns:
            Median upside percentage on 0-100 scale. Positive indicates upside potential.
            None if no recent analyst ratings available.
        """
        ratings = parse_ratings(self.ticker)
        return ratings.get("median_upside_pct") if ratings else None

    @property
    def ratings(self) -> list[dict] | None:
        """Raw analyst rating records from recent upgrades/downgrades (last 90 days)."""
        ratings = parse_ratings(self.ticker)
        return ratings.get("ratings") if ratings else None

    def get_all_indicators(self) -> dict:
        """Get all available indicators as a dictionary."""
        exclude = {"ticker", "info", "get_all_indicators"}
        return {name: getattr(self, name) for name in dir(self) if not name.startswith("_") and name not in exclude and isinstance(getattr(type(self), name, None), property)}
