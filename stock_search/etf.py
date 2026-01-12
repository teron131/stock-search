from .llm.agents import WebLoaderAgent
from .schema import ETF

ETF_SYSTEM_PROMPT = """Find the top ETF holdings and sector weightings from the provided web content. For holdings, extract the ticker, full company name, and weight percentage. For sectors, extract the sector name and weight percentage. Only include data you can clearly identify from the content. Standardize sectors to the list: Technology, Materials, Financials, Healthcare, Industrials, Real Estate, Energy, Utilities, Consumer Discretionary, Communication Services, Consumer Staples. https://stockanalysis.com/etf/[TICKER]/holdings/ where [TICKER] is the ETF ticker."""


def get_etf_data(etf_ticker: str) -> ETF:
    """Get the ETF data for a given ETF ticker."""
    agent = WebLoaderAgent(
        system_prompt=ETF_SYSTEM_PROMPT,
        response_format=ETF,
    )
    return agent.invoke(etf_ticker)
