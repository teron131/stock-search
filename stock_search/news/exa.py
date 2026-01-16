"""Exa
Playground: https://dashboard.exa.ai/playground/search
Documentation: https://docs.exa.ai/reference/search
- $5 per 1000 results when max results is up to 25
- Other LLM analysis costs apply, so disabled here
"""

from datetime import UTC, datetime, timedelta
import os

import requests

from ..schemas import News
from ..utils import format_date, format_iso_z, get_days_ago, parse_date, parse_ticker


def get_news_exa(
    query: str,
    n_days: int = 3,
    max_results: int = 25,
) -> list[News]:
    """Search Exa for news results and return raw payload items."""
    payload = {
        "query": parse_ticker(query),
        "category": "news",
        "num_results": max_results,
        "start_published_date": format_iso_z(datetime.now(UTC) - timedelta(days=n_days)),
        "end_published_date": format_iso_z(datetime.now(UTC)),
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
    results = response.json().get("results", [])

    news_list = []
    for result in results:
        dt = parse_date(result["publishedDate"])
        news_list.append(
            News(
                title=result["title"],
                url=result["url"],
                date=format_date(dt),
                days_ago=get_days_ago(dt),
                summary="[FAILED TO FETCH]",
            )
        )
    return news_list
