import yfinance as yf
from pydantic import BaseModel, ConfigDict

RSI_PERIOD = 14
MARKET_CAP_UNITS = [(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")]


class YFinanceInfo(BaseModel):
    """Wrapper for yfinance ticker.info dictionary with type safety."""

    model_config = ConfigDict(extra="ignore")

    postMarketPrice: float | None = None
    preMarketPrice: float | None = None
    regularMarketPrice: float | None = None
    regularMarketPreviousClose: float | None = None
    marketCap: int | None = None
    trailingPE: float | None = None
    forwardPE: float | None = None
    earningsGrowth: float | None = None
    grossMargins: float | None = None
    twentyDayAverageChangePercent: float | None = None
    fiftyDayAverageChangePercent: float | None = None
    oneHundredDayAverageChangePercent: float | None = None
    twoHundredDayAverageChangePercent: float | None = None


class StockIndicator:
    def __init__(self, ticker: str):
        self.ticker = yf.Ticker(ticker)
        self.info = YFinanceInfo.model_validate(self.ticker.info)

    @staticmethod
    def _round(value: float | None, decimals: int = 3) -> float | None:
        """Round value to specified decimals if not None."""
        return round(value, decimals) if value is not None else None

    @staticmethod
    def _format_number(value: float | None, prefix: str = "", suffix: str = "", decimals: int = 3, show_sign: bool = False) -> str | None:
        """Format number with optional prefix, suffix, and sign."""
        if value is None:
            return None
        sign = ("+" if value >= 0 else "") if show_sign else ""
        return f"{sign}{prefix}{value:.{decimals}f}{suffix}"

    @property
    def price(self) -> float | None:
        """Get latest price in order of postMarket, preMarket, or regularMarket.

        Returns:
            Price in currency units (typically USD). None if unavailable.
        """
        price = self.info.postMarketPrice or self.info.preMarketPrice or self.info.regularMarketPrice
        return self._round(price)

    @property
    def price_str(self) -> str | None:
        """String representation of price with dollar sign."""
        return self._format_number(self.price, prefix="$")

    def _get_previous_close(self) -> float | None:
        """Get appropriate previous close based on current price source.

        Returns:
            Previous close price in currency units (typically USD). None if unavailable.
        """
        if self.info.postMarketPrice is not None:
            return self._round(self.info.regularMarketPreviousClose)
        if self.info.preMarketPrice is not None:
            return self._round(self.info.postMarketPrice or self.info.regularMarketPreviousClose)
        return self._round(self.info.regularMarketPreviousClose)

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
        return self._round(current_price - previous_close)

    @property
    def change_str(self) -> str | None:
        """String representation of change with dollar sign."""
        return self._format_number(self.change, prefix="$", show_sign=True)

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
        return self._round(((current_price - previous_close) / previous_close) * 100)

    @property
    def change_percent_str(self) -> str | None:
        """String representation of change percentage with percent sign."""
        return self._format_number(self.change_percent, suffix="%", show_sign=True)

    @property
    def market_cap(self) -> str | None:
        """Format market cap as T/B/M/K with appropriate precision.

        Calculation: Divides raw market cap value by appropriate unit (trillion/billion/million/thousand)
        and formats with 3 decimal places.

        Returns:
            Formatted string (e.g., "1.234T", "567.890B") in currency units (typically USD).
            None if market cap unavailable.
        """
        if (market_cap := self.info.marketCap) is None:
            return None
        for divisor, suffix in MARKET_CAP_UNITS:
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
        return self._round(self.info.trailingPE)

    @property
    def pe_str(self) -> str | None:
        """String representation of P/E ratio."""
        return self._format_number(self.pe)

    @property
    def peg(self) -> float | None:
        """Price/Earnings to Growth ratio.

        Calculation: P/E ratio / Earnings growth rate

        Returns:
            PEG ratio (unitless). < 2 indicates reasonable price, < 1 means undervalued.
            None if P/E or earnings growth unavailable, or earnings growth is zero.
        """
        if (pe_value := self.pe) is None or (earnings_growth := self.info.earningsGrowth) is None or earnings_growth == 0:
            return None
        return self._round(pe_value / earnings_growth)

    @property
    def peg_str(self) -> str | None:
        """String representation of PEG ratio."""
        return self._format_number(self.peg)

    @property
    def earning_direction(self) -> str | None:
        """Direction of expected earnings change based on P/E ratios."""
        if not (trailing_pe := self.info.trailingPE) or not (forward_pe := self.info.forwardPE):
            return None
        return "Increase" if trailing_pe > forward_pe else "Decrease"

    @property
    def rsi(self) -> float | None:
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
            hist = self.ticker.history(period=f"{RSI_PERIOD + 10}d")
            if hist.empty or len(hist) < RSI_PERIOD + 1:
                return None

            deltas = hist["Close"].diff()
            gains = deltas.where(deltas > 0, 0)
            losses = -deltas.where(deltas < 0, 0)

            avg_gain = gains.rolling(window=RSI_PERIOD).mean().iloc[-1]
            avg_loss = losses.rolling(window=RSI_PERIOD).mean().iloc[-1]

            if avg_loss == 0:
                return 100.0

            rs = avg_gain / avg_loss
            return self._round(100 - (100 / (1 + rs)))
        except Exception:
            return None

    @property
    def rsi_str(self) -> str | None:
        """String representation of RSI."""
        return self._format_number(self.rsi)

    @property
    def gross_margin(self) -> float | None:
        """Gross margin as a percentage.

        Calculation: (Revenue - Cost of Goods Sold) / Revenue * 100

        Returns:
            Gross margin percentage on 0-100 scale. Higher values indicate better profitability.
            None if unavailable.
        """
        return self._round(self.info.grossMargins * 100) if self.info.grossMargins is not None else None

    @property
    def gross_margin_str(self) -> str | None:
        """String representation of gross margin with percent sign."""
        return self._format_number(self.gross_margin, suffix="%")

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
            ema = hist["Close"].ewm(span=days, adjust=False).mean().iloc[-1]
            if ema == 0:
                return None
            return self._round(((current_price / ema) - 1) * 100)
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
        if (change := getattr(self.info, key)) is not None:
            return self._round(change * 100)
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
        return self._format_number(self.twenty_day_change_percent, suffix="%", show_sign=True)

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
        return self._format_number(self.fifty_day_change_percent, suffix="%", show_sign=True)

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
        return self._format_number(self.one_hundred_day_change_percent, suffix="%", show_sign=True)

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
        return self._format_number(self.two_hundred_day_change_percent, suffix="%", show_sign=True)

    def get_all_indicators(self) -> dict:
        """Get all available indicators as a dictionary."""
        exclude = {"ticker", "info", "get_all_indicators"}
        return {name: getattr(self, name) for name in dir(self) if not name.startswith("_") and name not in exclude and isinstance(getattr(type(self), name, None), property)}
