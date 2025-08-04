import yfinance as yf


class StockIndicator:
    def __init__(self, ticker: str):
        self.ticker = yf.Ticker(ticker)
        self.info = self.ticker.info
        self.price = self.info["regularMarketPreviousClose"]

    @property
    def market_cap(self) -> float:
        return f"{self.info["marketCap"] / 1e12}B" if self.info["marketCap"] > 1e12 else f"{self.info["marketCap"] / 1e9}M"

    @property
    def volume_surge_percent(self) -> float:
        return (self.info["volume"] / self.info["averageVolume10days"] - 1) * 100

    @property
    def earning_direction(self) -> str:
        # Forward P/E can be lower than the trailing P/E if a company is expected to increase its earnings in the coming year, vice versa
        # > 0 when analysts expect earnings to grow faster than price
        return "Increase" if (self.info["trailingPE"] - self.info["forwardPE"]) / self.info["trailingPE"] > 0 else "Decrease"

    @property
    def eps_growth_percent(self) -> float:
        return (self.info["forwardEps"] / self.info["trailingEps"] - 1) * 100

    @property
    def expected_earnings_percent(self) -> float:
        return self.info["grossMargins"] * 100

    @property
    def reasonable_priced(self) -> bool:
        # < 1 indicates reasonable price
        return self.info["trailingPE"] / (self.info["earningsGrowth"] * 100) < 1

    @property
    def fifty_day_change_percent(self) -> float:
        return self.info["fiftyDayAverageChangePercent"] * 100

    @property
    def two_hundred_day_change_percent(self) -> float:
        return self.info["twoHundredDayAverageChangePercent"] * 100

    @property
    def ma_strategy(self) -> str:
        """Simplified Moving Average Strategy - Single Signal Output."""
        ma_50 = self.info["fiftyDayAverage"]
        ma_200 = self.info["twoHundredDayAverage"]
        current_price = self.price

        # Calculate key metrics
        above_200ma = current_price > ma_200
        above_50ma = current_price > ma_50
        golden_cross = ma_50 > ma_200

        # Distance from 200MA (key trend indicator)
        distance_200 = ((current_price - ma_200) / ma_200) * 100

        # Simple classification based on 200MA strategy
        if above_200ma and golden_cross and above_50ma:
            if distance_200 > 10:
                return "🚀 STRONG BULLISH - All signals aligned, price well above 200MA"
            else:
                return "📈 BULLISH - Above both moving averages, uptrend confirmed"
        elif above_200ma and golden_cross:
            return "✅ CAUTIOUSLY BULLISH - Above 200MA with golden cross, watch 50MA"
        elif above_200ma:
            return "🟡 NEUTRAL BULLISH - Above 200MA but mixed short-term signals"
        elif not above_200ma and not golden_cross and not above_50ma:
            if distance_200 < -10:
                return "🐻 STRONG BEARISH - All signals down, price well below 200MA"
            else:
                return "📉 BEARISH - Below both moving averages, downtrend confirmed"
        elif not above_200ma and not golden_cross:
            return "⚠️ CAUTIOUSLY BEARISH - Below 200MA with death cross, avoid"
        else:
            return "🔄 CONSOLIDATION - Mixed signals, price between moving averages"

    @property
    def upside_downside(self) -> str:
        return (self.info["targetMedianPrice"] / self.info["currentPrice"] - 1) * 100

    @property
    def analyst_rating(self) -> str:
        return self.info["averageAnalystRating"].split(" - ")[1]

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
