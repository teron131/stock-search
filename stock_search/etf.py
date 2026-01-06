from dotenv import load_dotenv

from .openrouter import ChatOpenRouter
from .schema import ETF

load_dotenv()


def get_etf_data(etf_ticker: str) -> ETF:
    """Get the ETF data for a given ETF ticker.

    Uses OpenRouter web search to extract holdings and sector weights.
    """
    llm = ChatOpenRouter(
        model="google/gemini-3-flash-preview",
        temperature=0,
        reasoning_effort="low",
        web_search=True,
        web_search_max_results=5,
    ).with_structured_output(ETF)

    prompt = f"Extract ETF holdings and sector weightings from the provided web content. For holdings, extract the ticker, full company name, and weight percentage. For sectors, extract the sector name and weight percentage. Only include data you can clearly identify from the content. Standardize sectors to the list: Technology, Materials, Financials, Healthcare, Industrials, Real Estate, Energy, Utilities, Consumer Discretionary, Communication Services, Consumer Staples. ETF ticker: {etf_ticker}"

    response: ETF = llm.invoke(prompt)
    return response
