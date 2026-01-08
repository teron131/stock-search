from datetime import UTC, date, datetime, timedelta
import os

from dotenv import load_dotenv
import requests

from ..schema import News
from ..utils import format_date

load_dotenv()


def get_news_newsapi(
    ticker: str,
    n_days: int = 3,
    max_results: int = 10,
) -> list[News]:
    """Get financial news using NewsAPI."""
    url = "https://newsapi.org/v2/everything"
    params = {
        "q": (
            f"{ticker} AND (stock OR shares OR market OR finance OR invest OR trade "
            "OR price OR analyst OR earnings OR guidance OR revenue OR profit OR "
            "upgrade OR downgrade OR target OR dividend OR buyback OR SEC OR "
            "regulatory OR merger OR acquisition OR lawsuit OR recall)"
        ),
        "from": format_date(datetime.now(UTC) - timedelta(days=n_days)),
        "to": format_date(datetime.now(UTC) - timedelta(days=1)),
        "language": "en",
        "sortBy": "popularity",
        "pageSize": max_results,
        "apiKey": os.getenv("NEWS_API_KEY"),
    }

    response = requests.get(url, params=params, timeout=60)
    response.raise_for_status()
    raw_articles = response.json().get("articles", [])
    if not raw_articles:
        return []

    return [
        News(
            title=article["title"],
            url=article["url"],
            date=(date_str := format_date(datetime.fromisoformat(article["publishedAt"].replace("Z", "+00:00")))),
            days_ago=(datetime.now(UTC).date() - date.fromisoformat(date_str)).days,
        )
        for article in raw_articles
    ]
