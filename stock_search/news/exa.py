"""Exa
Playground: https://dashboard.exa.ai/playground/search
Documentation: https://docs.exa.ai/reference/search
"""

from datetime import UTC, datetime, timedelta
import os

from dotenv import load_dotenv
from exa_py import Exa

from ..utils import format_iso_z

load_dotenv()

client = Exa(api_key=os.getenv("EXA_API_KEY"))


def get_news_exa(
    query: str,
    n_days: int = 3,
    num_results: int = 10,
    user_location: str = "US",
) -> list[dict]:
    """Search Exa for news results and return raw payload items."""
    end_published_date = format_iso_z(datetime.now(UTC))
    start_published_date = format_iso_z(datetime.now(UTC) - timedelta(days=n_days))

    result = client.search(
        query,
        category="news",
        num_results=num_results,
        start_published_date=start_published_date,
        end_published_date=end_published_date,
        type="auto",
        user_location=user_location,
    )
    return result.results
