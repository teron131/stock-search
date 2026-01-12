from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain_core.messages import HumanMessage

from .llm import ChatOpenRouter, webloader_tool
from .schema import ETF

load_dotenv()


def get_etf_data(
    etf_ticker: str,
) -> ETF:
    """Get the ETF data for a given ETF ticker.

    Uses OpenRouter web search to extract holdings and sector weights.
    """
    model = ChatOpenRouter(
        model="google/gemini-2.5-flash-lite-preview-09-2025",
        temperature=0,
        reasoning_effort="low",
    )

    agent = create_agent(
        model=model,
        tools=[webloader_tool],
        system_prompt="Find the top ETF holdings and sector weightings from the provided web content. For holdings, extract the ticker, full company name, and weight percentage. For sectors, extract the sector name and weight percentage. Only include data you can clearly identify from the content. Standardize sectors to the list: Technology, Materials, Financials, Healthcare, Industrials, Real Estate, Energy, Utilities, Consumer Discretionary, Communication Services, Consumer Staples. https://stockanalysis.com/etf/[TICKER]/holdings/ where [TICKER] is the ETF ticker.",
        response_format=ETF,
    )

    input = {"messages": [HumanMessage(content=etf_ticker)]}
    return agent.invoke(input).get("structured_response")
