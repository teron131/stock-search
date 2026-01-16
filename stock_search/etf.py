import os

from .llm_harness import WebLoaderAgent
from .schemas import ETFHoldings

ETF_SYSTEM_PROMPT = """Extract ETF holdings and weightings from these websites:
https://stockanalysis.com/etf/{ticker}/holdings
https://www.schwab.wallst.com/schwab/Prospect/research/etfs/schwabETF/index.asp?type=holdings&symbol={ticker}
https://www.tradingview.com/symbols/{ticker}/holdings

Exclude the exchange prefix from the ticker symbol if it is in the US.
Only include the exchange prefix from the ticker symbol if it is not in the US, such as 'EPA:HO', '1329.T'."""


def get_etf_data(etf_ticker: str) -> ETFHoldings:
    """Get the ETF data for a given ETF ticker."""
    ticker = etf_ticker.upper().strip()
    agent = WebLoaderAgent(
        model=os.getenv("QUALITY_LLM"),
        reasoning_effort="low",
        system_prompt=ETF_SYSTEM_PROMPT.format(ticker=ticker),
        response_format=ETFHoldings,
    )
    return agent.invoke(ticker)
