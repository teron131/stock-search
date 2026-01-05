from datetime import UTC, datetime, timedelta

import pandas as pd
import yfinance as yf


def parse_ratings(ticker: str | yf.Ticker, days: int = 90) -> dict | None:
    """Parse analyst ratings for a ticker and calculate upside metrics.

    Args:
        ticker: Ticker symbol string or yf.Ticker instance
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
        self.info = self.ticker.info

    @property
    def price(self) -> float | None:
        """Get latest price in order of postMarket, preMarket, or regularMarket.

        Returns:
            Price in currency units (typically USD). None if unavailable.
        """
        price = self.info.get("postMarketPrice") or self.info.get("preMarketPrice") or self.info.get("regularMarketPrice")
        return _round(price)

    @property
    def price_str(self) -> str | None:
        """String representation of price with dollar sign."""
        return f"${self.price:.2f}" if self.price is not None else None

    def _get_previous_close(self) -> float | None:
        """Get appropriate previous close based on current price source.

        Returns:
            Previous close price in currency units (typically USD). None if unavailable.
        """
        if self.info.get("postMarketPrice") is not None:
            return _round(self.info.get("regularMarketPreviousClose"))
        if self.info.get("preMarketPrice") is not None:
            return _round(self.info.get("postMarketPrice") or self.info.get("regularMarketPreviousClose"))
        return _round(self.info.get("regularMarketPreviousClose"))

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
    def change_str(self) -> str | None:
        """String representation of change with dollar sign."""
        if self.change is None:
            return None
        if self.change >= 0:
            return f"+${self.change:.2f}"
        return f"-${abs(self.change):.2f}"

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
    def change_percent_str(self) -> str | None:
        """String representation of change percentage with percent sign."""
        return _format_with_sign(self.change_percent, "%")

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
        for divisor, suffix in [(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")]:
            if market_cap >= divisor:
                return f"{market_cap / divisor:.3f}{suffix}"
        return f"{market_cap:.3f}"

    @property
    def market_cap_str(self) -> str | None:
        """String representation of market cap with dollar sign."""
        return f"${self.market_cap}" if self.market_cap is not None else None

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
    def pe_str(self) -> str | None:
        """String representation of P/E ratio with percent sign."""
        return f"{self.pe:.2f}%" if self.pe is not None else None

    @property
    def peg(self) -> float | None:
        """Price/Earnings to Growth ratio. < 2 indicates reasonable price, < 1 means undervalued.

        Calculation: P/E ratio / (Earnings growth rate * 100)

        Returns:
            PEG ratio (unitless).
            None if P/E or earnings growth unavailable, or earnings growth is zero.
        """
        if (pe_value := self.pe) is None or (earnings_growth := self.info.get("earningsGrowth")) is None or earnings_growth == 0:
            return None
        # Convert earnings growth from decimal to percentage rate (e.g., 0.6667 -> 66.67)
        earnings_growth_rate = earnings_growth * 100
        return round(pe_value / earnings_growth_rate, 2)

    @property
    def peg_str(self) -> str | None:
        """String representation of PEG ratio."""
        return f"{self.peg:.2f}" if self.peg is not None else None

    @property
    def earning_direction(self) -> str | None:
        """Direction of expected earnings change based on P/E ratios."""
        if not (trailing_pe := self.info.get("trailingPE")) or not (forward_pe := self.info.get("forwardPE")):
            return None
        return "Increase" if trailing_pe > forward_pe else "Decrease"

    @property
    def rsi(self, days: int = 14) -> float | None:
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
    def rsi_str(self) -> str | None:
        """String representation of RSI."""
        return f"{self.rsi:.2f}" if self.rsi is not None else None

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

    @property
    def gross_margin_str(self) -> str | None:
        """String representation of gross margin with percent sign."""
        return f"{self.gross_margin:.2f}%" if self.gross_margin is not None else None

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
    def twenty_day_change_percent_str(self) -> str | None:
        """String representation of 20-day change percentage with percent sign."""
        return _format_with_sign(self.twenty_day_change_percent, "%")

    @property
    def fifty_day_change_percent(self) -> float | None:
        """50-day percentage change.

        Calculation: Percentage change from 50-day EMA (or from yfinance info if available).

        Returns:
            Percentage change on 0-100 scale. None if unavailable.
        """
        return self._get_day_change_percent(50, "fiftyDayAverageChangePercent")

    @property
    def fifty_day_change_percent_str(self) -> str | None:
        """String representation of 50-day change percentage with percent sign."""
        return _format_with_sign(self.fifty_day_change_percent, "%")

    @property
    def one_hundred_day_change_percent(self) -> float | None:
        """100-day percentage change.

        Calculation: Percentage change from 100-day EMA (or from yfinance info if available).

        Returns:
            Percentage change on 0-100 scale. None if unavailable.
        """
        return self._get_day_change_percent(100, "oneHundredDayAverageChangePercent")

    @property
    def one_hundred_day_change_percent_str(self) -> str | None:
        """String representation of 100-day change percentage with percent sign."""
        return _format_with_sign(self.one_hundred_day_change_percent, "%")

    @property
    def two_hundred_day_change_percent(self) -> float | None:
        """200-day percentage change.

        Calculation: Percentage change from 200-day EMA (or from yfinance info if available).

        Returns:
            Percentage change on 0-100 scale. None if unavailable.
        """
        return self._get_day_change_percent(200, "twoHundredDayAverageChangePercent")

    @property
    def two_hundred_day_change_percent_str(self) -> str | None:
        """String representation of 200-day change percentage with percent sign."""
        return _format_with_sign(self.two_hundred_day_change_percent, "%")

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
    def median_upside_str(self) -> str | None:
        """String representation of median upside with percent sign."""
        return _format_with_sign(self.median_upside, "%")

    def get_all_indicators(self) -> dict:
        """Get all available indicators as a dictionary."""
        exclude = {"ticker", "info", "get_all_indicators", "get_all_indicators_str"}
        return {
            name: getattr(self, name)
            for name in dir(self)
            if not name.startswith("_") and not name.endswith("_str") and name not in exclude and isinstance(getattr(type(self), name, None), property)
        }

    def get_all_indicators_str(self) -> dict:
        """Get all available string-formatted indicators as a dictionary."""
        exclude = {"ticker", "info", "get_all_indicators", "get_all_indicators_str"}
        return {
            name: getattr(self, name)
            for name in dir(self)
            if not name.startswith("_") and name.endswith("_str") and name not in exclude and isinstance(getattr(type(self), name, None), property)
        }
