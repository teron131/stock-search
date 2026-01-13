"""NewsAPI
Documentation: https://newsapi.org/docs/endpoints/everything
- Free
- 24 hours delay
- 100 requests per day
"""

from datetime import UTC, datetime, timedelta
import os

from dotenv import load_dotenv
import requests

from ..schema import News
from ..utils import format_date, get_days_ago, parse_date, parse_ticker

load_dotenv()


def get_news_newsapi(
    query: str,
    n_days: int = 3,
    max_results: int = 25,
) -> list[News]:
    """Get financial news using NewsAPI."""
    params = {
        "apiKey": os.getenv("NEWS_API_KEY"),
        "q": parse_ticker(query),
        "from": (datetime.now(UTC) - timedelta(days=n_days)).strftime("%Y-%m-%d"),
        "to": (datetime.now(UTC) - timedelta(days=1)).strftime("%Y-%m-%d"),
        "language": "en",
        "sortBy": "popularity",
        "pageSize": max_results,
    }
    response = requests.get(
        url="https://newsapi.org/v2/everything",
        params=params,
        timeout=60,
    )
    response.raise_for_status()
    results = response.json().get("articles", [])

    news_list = []
    for result in results:
        dt = parse_date(result["publishedAt"])
        news_list.append(
            News(
                title=result["title"],
                url=result["url"],
                date=format_date(dt),
                days_ago=get_days_ago(dt),
                summary=f"[TRUNCATED] {result['description']}",
            )
        )
    return news_list
