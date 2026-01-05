import os

from dotenv import load_dotenv
import yfinance as yf

from .openrouter import ChatOpenRouter
from .schema import ETF

load_dotenv()

FAST_LLM = os.getenv("FAST_LLM", "google/gemini-2.5-flash-lite")


def get_etf_data_yf(etf_symbol: str) -> dict:
    """Return top holdings from yfinance funds_data (may be inaccurate)."""
    return yf.Ticker(etf_symbol).funds_data.top_holdings.to_dict()


def get_etf_sector_weightings_yf(etf_symbol: str) -> dict:
    """Return sector weightings from yfinance funds_data (already a dict)."""
    return yf.Ticker(etf_symbol).funds_data.sector_weightings


def get_etf_data(etf_symbol: str) -> ETF:
    """Get the ETF data for a given ETF symbol.

    It uses OpenRouter with web search to extract holdings and sector weights from Finviz.
    """
    llm = ChatOpenRouter(
        model="google/gemini-3-flash-preview",
        temperature=0,
        # reasoning_effort="minimal",
        web_search=True,
        web_search_max_results=1,
    ).with_structured_output(ETF)
    prompt = f"""Extract the top holdings and sector percentages of {etf_symbol} from:
https://stockanalysis.com/etf/{etf_symbol}/holdings/
List the top holdings with their ticker, name, and weight.
List the sectors with their name and weight."""
    response: ETF = llm.invoke(prompt)
    return response
