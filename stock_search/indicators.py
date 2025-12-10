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

    @property
    def price(self) -> float | None:
        """Get latest price in order of postMarket, preMarket, or regularMarket."""
        return self.info.postMarketPrice or self.info.preMarketPrice or self.info.regularMarketPrice

    def _get_previous_close(self) -> float | None:
        """Get appropriate previous close based on current price source."""
        if self.info.postMarketPrice is not None:
            return self.info.regularMarketPreviousClose
        if self.info.preMarketPrice is not None:
            return self.info.postMarketPrice or self.info.regularMarketPreviousClose
        return self.info.regularMarketPreviousClose

    @property
    def change(self) -> float | None:
        """Calculate change from previous close based on current price source."""
        if (current_price := self.price) is None or (previous_close := self._get_previous_close()) is None:
            return None
        return current_price - previous_close

    @property
    def change_percent(self) -> float | None:
        """Calculate percentage change from previous close based on current price source."""
        if (current_price := self.price) is None or (previous_close := self._get_previous_close()) is None or previous_close == 0:
            return None
        return ((current_price - previous_close) / previous_close) * 100

    @property
    def market_cap(self) -> str | None:
        """Format market cap as T/B/M/K with appropriate precision."""
        if (market_cap := self.info.marketCap) is None:
            return None
        for divisor, suffix in MARKET_CAP_UNITS:
            if market_cap >= divisor:
                return f"{market_cap / divisor:.3f}{suffix}"
        return f"{market_cap:.3f}"

    @property
    def pe(self) -> float | None:
        """Price-to-Earnings ratio (trailing P/E)."""
        return self.info.trailingPE

    @property
    def peg(self) -> float | None:
        """Price/Earnings to Growth ratio. < 2 indicates reasonable price and < 1 means undervalued."""
        if (pe_value := self.pe) is None:
            return None
        if (earnings_growth := self.info.earningsGrowth) is None or earnings_growth == 0:
            return None
        return pe_value / earnings_growth

    @property
    def earning_direction(self) -> str | None:
        """Direction of expected earnings change based on P/E ratios."""
        if not (trailing_pe := self.info.trailingPE) or not (forward_pe := self.info.forwardPE):
            return None
        return "Increase" if trailing_pe > forward_pe else "Decrease"

    @property
    def rsi(self) -> float | None:
        """Relative Strength Index (RSI, 14-period). 70+ overbought, 30- oversold."""
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
            return round(100 - (100 / (1 + rs)), 2)
        except Exception:
            return None

    @property
    def gross_margin(self) -> float | None:
        """Gross margin as a percentage."""
        return self.info.grossMargins * 100 if self.info.grossMargins is not None else None

    def _calculate_change_percent(self, days: int) -> float | None:
        """Calculate percentage change as (price / EMA - 1) * 100."""
        try:
            hist = self.ticker.history(period=f"{days + 30}d")
            if hist.empty or len(hist) < days:
                return None
            if (current_price := self.price) is None:
                return None
            ema = hist["Close"].ewm(span=days, adjust=False).mean().iloc[-1]
            if ema == 0:
                return None
            return ((current_price / ema) - 1) * 100
        except Exception:
            return None

    def _get_day_change_percent(self, days: int, key: str) -> float | None:
        """Get day change percent from info or calculate it."""
        if (change := getattr(self.info, key)) is not None:
            return change * 100
        return self._calculate_change_percent(days)

    @property
    def twenty_day_change_percent(self) -> float | None:
        """20-day percentage change."""
        return self._get_day_change_percent(20, "twentyDayAverageChangePercent")

    @property
    def fifty_day_change_percent(self) -> float | None:
        """50-day percentage change."""
        return self._get_day_change_percent(50, "fiftyDayAverageChangePercent")

    @property
    def one_hundred_day_change_percent(self) -> float | None:
        """100-day percentage change."""
        return self._get_day_change_percent(100, "oneHundredDayAverageChangePercent")

    @property
    def two_hundred_day_change_percent(self) -> float | None:
        """200-day percentage change."""
        return self._get_day_change_percent(200, "twoHundredDayAverageChangePercent")

    def get_all_indicators(self) -> dict:
        """Get all available indicators as a dictionary."""
        exclude = {"ticker", "info", "get_all_indicators"}
        return {name: getattr(self, name) for name in dir(self) if not name.startswith("_") and name not in exclude and isinstance(getattr(type(self), name, None), property)}
