import os

from dotenv import load_dotenv
from google.genai import Client, types

from .schema import ETF

load_dotenv()


def get_etf_data(etf_symbol: str) -> ETF:
    """Get the ETF data for a given ETF symbol.

    It uses the Gemini URL context tool to get the data from the ETF Database website.

    Gemini does not support structured output when using the URL context tool, so it is separated into two steps.
    """
    client = Client(
        api_key=os.getenv("GEMINI_API_KEY"),
        http_options={"timeout": 600000},  # 10 minutes timeout
    )

    # Step 1: Get raw data using URL context tool
    url_context_tool = types.Tool(url_context=types.UrlContext())

    raw_response = client.models.generate_content(
        model=os.getenv("FAST_LLM"),
        contents=f"""Extract the top holdings and sector percentages of {etf_symbol} in:
https://finviz.com/quote.ashx?t={etf_symbol}
List the top holdings with their ticker, name, and weight.
List the sectors with their name and weight.""",
        config=types.GenerateContentConfig(
            tools=[url_context_tool],
            temperature=0,
            response_modalities=["TEXT"],
        ),
    )

    # Step 2: Parse the raw data into structured format
    structured_response = client.models.generate_content(
        model=os.getenv("FAST_LLM"),
        contents=f"Parse this ETF data into the required structure:\n\n{raw_response.text}",
        config=types.GenerateContentConfig(
            temperature=0,
            response_modalities=["TEXT"],
            response_mime_type="application/json",
            response_schema=ETF,
        ),
    )

    return structured_response.parsed
