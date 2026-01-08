"""Exa
Playground: https://dashboard.exa.ai/playground/search
Documentation: https://docs.exa.ai/reference/search
- $5 per 1000 results when max results is up to 25
- Other LLM analysis costs apply, so disabled here
"""

from datetime import UTC, date, datetime, timedelta
import os

from dotenv import load_dotenv
import requests

from ..schema import News
from ..utils import format_date, format_iso_z

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

    return [
        News(
            title=news["title"],
            url=news["url"],
            date=(date_str := format_date(datetime.fromisoformat(news["publishedDate"].replace("Z", "+00:00")))),
            days_ago=(datetime.now(UTC).date() - date.fromisoformat(date_str)).days,
            summary="[FAILED TO FETCH]",
        )
        for news in news_list
    ]
