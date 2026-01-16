from .llm_harness import WebLoaderAgent
from .schemas import ETFHoldings

ETF_SYSTEM_PROMPT = """Extract ETF holdings and sector weightings from these websites:
https://stockanalysis.com/etf/{ticker}/holdings
https://www.schwab.wallst.com/schwab/Prospect/research/etfs/schwabETF/index.asp?type=holdings&symbol={ticker}
https://www.tradingview.com/symbols/{ticker}/holdings

Holdings: ticker symbol (without exchange prefix) weight percentage.
Sectors: sector name and weight percentage (standardize to: Technology, Materials, Financials, Healthcare, Industrials, Real Estate, Energy, Utilities, Consumer Discretionary, Communication Services, Consumer Staples, Other)."""


def get_etf_data(etf_ticker: str) -> ETFHoldings:
    """Get the ETF data for a given ETF ticker."""
    ticker = etf_ticker.upper().strip()
    agent = WebLoaderAgent(
        model="openai/gpt-5-mini",
        reasoning_effort="low",
        system_prompt=ETF_SYSTEM_PROMPT.format(ticker=ticker),
        response_format=ETFHoldings,
    )
    return agent.invoke(ticker)
