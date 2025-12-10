from typing import Any, Dict, List, Optional, Tuple

import yfinance as yf

PRICE_KEYS: List[str] = ["postMarketPrice", "preMarketPrice", "regularMarketPrice"]
MARKET_CAP_DIVISORS: List[Tuple[float, str]] = [(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")]


class StockIndicator:
    def __init__(self, ticker: str):
        self.ticker = yf.Ticker(ticker)
        self.info = self.ticker.info
        self._history_cache: Dict[str, Any] = {}

    def _get_history(self, days: int):
        """Get stock history, caching the result."""
        # Round up to nearest standard period or just cache by days
        # To optimize, we could always fetch max days needed (e.g. 250) and slice
        if days not in self._history_cache:
            try:
                # Add buffer days
                self._history_cache[days] = self.ticker.history(period=f"{days}d")
            except Exception:
                return None
        return self._history_cache.get(days)

    @property
    def price(self) -> float | None:
        """Get latest price in order of postMarket, preMarket, or regularMarket."""
        for price_key in PRICE_KEYS:
            if (price := self.info.get(price_key)) is not None:
                return price
        return None

    def _get_previous_close(self) -> float | None:
        """Get appropriate previous close based on current price source."""
        if self.info.get("postMarketPrice") is not None:
            return self.info.get("regularMarketPreviousClose")
        if self.info.get("preMarketPrice") is not None:
            return self.info.get("postMarketPrice") or self.info.get("regularMarketPreviousClose")
        return self.info.get("regularMarketPreviousClose")

    @property
    def change(self) -> float | None:
        """Calculate change from previous close based on current price source."""
        current_price = self.price
        if current_price is None:
            return None
        previous_close = self._get_previous_close()
        if previous_close is None:
            return None
        return current_price - previous_close

    @property
    def change_percent(self) -> float | None:
        """Calculate percentage change from previous close based on current price source."""
        current_price = self.price
        if current_price is None:
            return None
        previous_close = self._get_previous_close()
        if not previous_close:
            return None
        return ((current_price - previous_close) / previous_close) * 100

    @property
    def market_cap(self) -> str | None:
        """Format market cap as T/B/M/K with appropriate precision."""
        market_cap = self.info.get("marketCap")
        if market_cap is None:
            return None

        for divisor, suffix in MARKET_CAP_DIVISORS:
            if market_cap >= divisor:
                return f"{(market_cap / divisor):.3f}{suffix}"

        return f"{market_cap:.3f}"

    @property
    def pe(self) -> float | None:
        """Price-to-Earnings ratio (trailing P/E)."""
        return self.info.get("trailingPE")

    @property
    def peg(self) -> float | None:
        """Price/Earnings to Growth ratio. < 2 indicates reasonable price and < 1 means undervalued."""
        pe_value = self.pe
        earnings_growth = self.info.get("earningsGrowth")

        if pe_value is None or not earnings_growth:
            return None

        return pe_value / earnings_growth

    @property
    def earning_direction(self) -> str | None:
        """Direction of expected earnings change based on P/E ratios."""
        trailing_pe = self.info.get("trailingPE")
        forward_pe = self.info.get("forwardPE")

        if not trailing_pe or forward_pe is None:
            return None

        return "Increase" if (trailing_pe - forward_pe) / trailing_pe > 0 else "Decrease"

    @property
    def rsi(self) -> float | None:
        """Relative Strength Index (RSI, 14-period). 70+ overbought, 30- oversold."""
        period = 14
        # Fetch slightly more history to ensure we have enough data points
        # 14 periods + 10 buffer
        hist = self._get_history(period + 10)

        if hist is None or hist.empty or len(hist) < period + 1:
            return None

        try:
            close_prices = hist["Close"]
            deltas = close_prices.diff()

            gains = deltas.where(deltas > 0, 0)
            losses = -deltas.where(deltas < 0, 0)

            avg_gain = gains.rolling(window=period).mean().iloc[-1]
            avg_loss = losses.rolling(window=period).mean().iloc[-1]

            if avg_loss == 0:
                return 100.0

            rs = avg_gain / avg_loss
            return round(100 - (100 / (1 + rs)), 2)
        except Exception:
            return None

    @property
    def gross_margin(self) -> float | None:
        """Gross margin as a percentage."""
        gross_margins = self.info.get("grossMargins")
        return gross_margins * 100 if gross_margins is not None else None

    def _calculate_change_percent(self, days: int) -> float | None:
        """Calculate percentage change as (price / EMA - 1) * 100."""
        # Add buffer days for EMA calculation
        hist = self._get_history(days + 30)

        if hist is None or hist.empty or len(hist) < days:
            return None

        current_price = self.price
        if current_price is None:
            return None

        try:
            close_prices = hist["Close"]
            ema = close_prices.ewm(span=days, adjust=False).mean().iloc[-1]

            if ema == 0:
                return None

            return ((current_price / ema) - 1) * 100
        except Exception:
            return None

    @property
    def twenty_day_change_percent(self) -> float | None:
        """20-day percentage change."""
        if (change := self.info.get("twentyDayAverageChangePercent")) is not None:
            return change * 100
        return self._calculate_change_percent(20)

    @property
    def fifty_day_change_percent(self) -> float | None:
        """50-day percentage change."""
        if (change := self.info.get("fiftyDayAverageChangePercent")) is not None:
            return change * 100
        return self._calculate_change_percent(50)

    @property
    def one_hundred_day_change_percent(self) -> float | None:
        """100-day percentage change."""
        if (change := self.info.get("oneHundredDayAverageChangePercent")) is not None:
            return change * 100
        return self._calculate_change_percent(100)

    @property
    def two_hundred_day_change_percent(self) -> float | None:
        """200-day percentage change."""
        if (change := self.info.get("twoHundredDayAverageChangePercent")) is not None:
            return change * 100
        return self._calculate_change_percent(200)

    def get_all_indicators(self) -> Dict[str, Any]:
        """Get all available indicators as a dictionary."""
        # Explicit list of properties to include
        properties = [
            "price",
            "change",
            "change_percent",
            "market_cap",
            "pe",
            "peg",
            "earning_direction",
            "rsi",
            "gross_margin",
            "twenty_day_change_percent",
            "fifty_day_change_percent",
            "one_hundred_day_change_percent",
            "two_hundred_day_change_percent",
        ]

        indicators = {}
        for prop in properties:
            value = getattr(self, prop)
            if value is not None:
                indicators[prop] = value

        return indicators
