"""Massive
Documentation: https://massive.com/docs/rest/stocks/news
- Free
- 5 API Calls / Minute
"""

from datetime import UTC, datetime, timedelta
import os

from dotenv import load_dotenv
import requests

from ..schema import News
from ..utils import format_date, get_days_ago, parse_date

load_dotenv()


def get_news_massive(
    query: str,
    n_days: int = 3,
    max_results: int = 25,
) -> list[News]:
    """Get financial news using Massive API."""
    # Massive API expects dates in ISO 8601 format (date-time or date)
    from_date = (datetime.now(UTC) - timedelta(days=n_days)).isoformat()

    params = {
        "apiKey": os.getenv("MASSIVE_API_KEY"),
        "ticker": query,
        "published_utc.gte": from_date,
        "order": "desc",
        "limit": max_results,
        "sort": "published_utc",
    }
    response = requests.get(
        url="https://api.massive.com/v2/reference/news",
        params=params,
        timeout=60,
    )
    response.raise_for_status()
    news_list = response.json().get("results", [])

    results = []
    for news in news_list:
        dt = parse_date(news["published_utc"])
        results.append(
            News(
                title=news["title"],
                url=news["article_url"],
                date=format_date(dt),
                days_ago=get_days_ago(dt),
                summary=news.get("description", "[FAILED TO FETCH]"),
            )
        )
    return results
