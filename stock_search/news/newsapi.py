"""NewsAPI
Documentation: https://newsapi.org/docs/endpoints/everything
- Free
- 24 hours delay
- 100 requests per day
"""

from datetime import UTC, date, datetime, timedelta
import os

from dotenv import load_dotenv
import requests

from ..schema import News
from ..utils import format_date

load_dotenv()


def get_news_newsapi(
    query: str,
    n_days: int = 3,
    max_results: int = 10,
) -> list[News]:
    """Get financial news using NewsAPI."""
    params = {
        "apiKey": os.getenv("NEWS_API_KEY"),
        "q": (
            f"{query} AND (stock OR shares OR market OR finance OR invest OR trade "
            "OR price OR analyst OR earnings OR guidance OR revenue OR profit OR "
            "upgrade OR downgrade OR target OR dividend OR buyback OR SEC OR "
            "regulatory OR merger OR acquisition OR lawsuit OR recall)"
        ),
        "from": format_date(datetime.now(UTC) - timedelta(days=n_days)),
        "to": format_date(datetime.now(UTC) - timedelta(days=1)),
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
    news_list = response.json().get("articles", [])

    return [
        News(
            title=news["title"],
            url=news["url"],
            date=(date_str := format_date(datetime.fromisoformat(news["publishedAt"].replace("Z", "+00:00")))),
            days_ago=(datetime.now(UTC).date() - date.fromisoformat(date_str)).days,
        )
        for news in news_list
    ]
