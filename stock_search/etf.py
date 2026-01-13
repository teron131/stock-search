from .llm import WebLoaderAgent
from .prompts import ETF_SYSTEM_PROMPT
from .schema import ETF


def get_etf_data(etf_ticker: str) -> ETF:
    """Get the ETF data for a given ETF ticker."""
    agent = WebLoaderAgent(
        system_prompt=ETF_SYSTEM_PROMPT,
        response_format=ETF,
    )
    return agent.invoke(etf_ticker)
