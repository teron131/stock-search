"""Exa
Playground: https://dashboard.exa.ai/playground/search
Documentation: https://docs.exa.ai/reference/search
- $5 per 1000 results when max results is up to 25
- Other LLM analysis costs apply, so disabled here
"""

from datetime import UTC, datetime, timedelta
import os

from dotenv import load_dotenv
import requests

from ..schema import News
from ..utils import format_date, format_iso_z, get_days_ago, parse_date

load_dotenv()


def get_news_exa(
    query: str,
    n_days: int = 3,
    num_results: int = 10,
) -> list[News]:
    """Search Exa for news results and return raw payload items."""
    end_published_date = format_iso_z(datetime.now(UTC))
    start_published_date = format_iso_z(datetime.now(UTC) - timedelta(days=n_days))

    payload = {
        "query": query,
        "category": "news",
        "num_results": num_results,
        "start_published_date": start_published_date,
        "end_published_date": end_published_date,
        "type": "auto",
        "user_location": "US",
    }
    headers = {
        "Authorization": f"Bearer {os.getenv('EXA_API_KEY')}",
        "Content-Type": "application/json",
    }
    response = requests.post(
        url="https://api.exa.ai/search",
        json=payload,
        headers=headers,
        timeout=60,
    )
    response.raise_for_status()
    news_list = response.json().get("results", [])

    results = []
    for news in news_list:
        dt = parse_date(news["publishedDate"])
        results.append(
            News(
                title=news["title"],
                url=news["url"],
                date=format_date(dt),
                days_ago=get_days_ago(dt),
                summary="[FAILED TO FETCH]",
            )
        )
    return results
