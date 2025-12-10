import yfinance as yf


class StockIndicator:
    def __init__(self, ticker: str):
        self.ticker = yf.Ticker(ticker)
        self.info = self.ticker.info

    @property
    def price(self) -> float | str:
        """Get latest price in order of postMarket, preMarket, or regularMarket."""
        for price_key in ["postMarketPrice", "preMarketPrice", "regularMarketPrice"]:
            if (price := self.info.get(price_key)) is not None:
                return price
        return "N/A"

    def _get_previous_close(self) -> float | None:
        """Get appropriate previous close based on current price source."""
        if self.info.get("postMarketPrice") is not None:
            return self.info.get("regularMarketPreviousClose")
        if self.info.get("preMarketPrice") is not None:
            return self.info.get("postMarketPrice") or self.info.get("regularMarketPreviousClose")
        return self.info.get("regularMarketPreviousClose")

    @property
    def change(self) -> float | str:
        """Calculate change from previous close based on current price source."""
        if (current_price := self.price) == "N/A":
            return "N/A"
        if (previous_close := self._get_previous_close()) is None:
            return "N/A"
        return current_price - previous_close

    @property
    def change_percent(self) -> float | str:
        """Calculate percentage change from previous close based on current price source."""
        if (current_price := self.price) == "N/A":
            return "N/A"
        if (previous_close := self._get_previous_close()) is None or previous_close == 0:
            return "N/A"
        return ((current_price - previous_close) / previous_close) * 100

    @property
    def market_cap(self) -> str:
        """Format market cap as T/B/M/K with appropriate precision."""
        if (market_cap := self.info.get("marketCap")) is None:
            return "N/A"

        for divisor, suffix in [(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")]:
            if market_cap >= divisor:
                return f"{(market_cap / divisor):.3f}{suffix}"

        return f"{market_cap:.3f}"

    @property
    def pe(self) -> float | str:
        """Price-to-Earnings ratio (trailing P/E)."""
        if (pe := self.info.get("trailingPE")) is None:
            return "N/A"
        return pe

    @property
    def peg(self) -> float | str:
        """Price/Earnings to Growth ratio. < 2 indicates reasonable price and < 1 means undervalued."""
        pe_value = self.pe
        if pe_value == "N/A":
            return "N/A"
        if (earnings_growth := self.info.get("earningsGrowth")) is None or earnings_growth == 0:
            return "N/A"
        return pe_value / earnings_growth

    @property
    def earning_direction(self) -> str:
        """Direction of expected earnings change based on P/E ratios."""
        # Forward P/E can be lower than the trailing P/E if a company is expected to increase its earnings in the coming year, vice versa
        # > 0 when analysts expect earnings to grow faster than price
        trailing_pe = self.info.get("trailingPE")
        forward_pe = self.info.get("forwardPE")
        if trailing_pe is None or forward_pe is None or trailing_pe == 0:
            return "N/A"
        return "Increase" if (trailing_pe - forward_pe) / trailing_pe > 0 else "Decrease"

    @property
    def rsi(self) -> float | str:
        """Relative Strength Index (RSI, 14-period). 70+ overbought, 30- oversold."""
        period = 14
        try:
            hist = self.ticker.history(period=f"{period + 10}d")
            if hist.empty or len(hist) < period + 1:
                return "N/A"

            close_prices = hist["Close"]
            deltas = close_prices.diff()

            gains = deltas.where(deltas > 0, 0)
            losses = -deltas.where(deltas < 0, 0)

            avg_gain = gains.rolling(window=period).mean().iloc[-1]
            avg_loss = losses.rolling(window=period).mean().iloc[-1]

            if avg_loss == 0:
                return 100.0

            rs = avg_gain / avg_loss
            rsi_value = 100 - (100 / (1 + rs))

            return round(rsi_value, 2)
        except Exception:
            return "N/A"

    @property
    def gross_margin(self) -> float:
        return self.info["grossMargins"] * 100

    def _calculate_change_percent(self, days: int) -> float | str:
        """Calculate percentage change as (price / EMA - 1) * 100."""
        try:
            hist = self.ticker.history(period=f"{days + 30}d")
            if hist.empty or len(hist) < days:
                return "N/A"

            current_price = self.price
            if current_price == "N/A":
                return "N/A"

            close_prices = hist["Close"]
            ema = close_prices.ewm(span=days, adjust=False).mean().iloc[-1]

            if ema == 0:
                return "N/A"

            return ((current_price / ema) - 1) * 100
        except Exception:
            return "N/A"

    @property
    def twenty_day_change_percent(self) -> float | str:
        """20-day percentage change."""
        if change := self.info.get("twentyDayAverageChangePercent"):
            return change * 100
        return self._calculate_change_percent(20)

    @property
    def fifty_day_change_percent(self) -> float | str:
        """50-day percentage change."""
        if change := self.info.get("fiftyDayAverageChangePercent"):
            return change * 100
        return self._calculate_change_percent(50)

    @property
    def one_hundred_day_change_percent(self) -> float | str:
        """100-day percentage change."""
        if change := self.info.get("oneHundredDayAverageChangePercent"):
            return change * 100
        return self._calculate_change_percent(100)

    @property
    def two_hundred_day_change_percent(self) -> float | str:
        """200-day percentage change."""
        if change := self.info.get("twoHundredDayAverageChangePercent"):
            return change * 100
        return self._calculate_change_percent(200)

    def get_all_indicators(self) -> dict:
        """Get all available indicators as a dictionary."""
        indicators = {}

        # Get all properties from the class (excluding private/special methods)
        for attr_name in dir(self):
            if not attr_name.startswith("_") and attr_name not in ["ticker", "info", "get_all_indicators"]:
                attr = getattr(self, attr_name)
                # Check if it's a property (not a method)
                if isinstance(getattr(type(self), attr_name, None), property):
                    indicators[attr_name] = attr

        return indicators
