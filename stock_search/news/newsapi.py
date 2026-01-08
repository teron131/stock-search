"""NewsAPI
Documentation: https://newsapi.org/docs/endpoints/everything
- Free
- 24 hours delay
- 100 requests per day
"""

from datetime import UTC, date, datetime, timedelta
import os

from dotenv import load_dotenv
from newsapi import NewsApiClient

from ..schema import News
from ..utils import format_date

load_dotenv()


client = NewsApiClient(api_key=os.getenv("NEWS_API_KEY"))


def get_news_newsapi(
    ticker: str,
    n_days: int = 3,
    max_results: int = 10,
) -> list[News]:
    """Get financial news using NewsAPI."""
    response = client.get_everything(
        q=(
            f"{ticker} AND (stock OR shares OR market OR finance OR invest OR trade "
            "OR price OR analyst OR earnings OR guidance OR revenue OR profit OR "
            "upgrade OR downgrade OR target OR dividend OR buyback OR SEC OR "
            "regulatory OR merger OR acquisition OR lawsuit OR recall)"
        ),
        from_param=format_date(datetime.now(UTC) - timedelta(days=n_days)),
        to=format_date(datetime.now(UTC) - timedelta(days=1)),
        language="en",
        sort_by="popularity",
        page_size=max_results,
    )
    raw_articles = response.get("articles", [])
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
