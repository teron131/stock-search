"""NewsData
Playground: https://newsdata.io/search-dashboard
Documentation: https://newsdata.io/documentation#latest-news
- Free
- 200 credits per day
- 10 articles per credit
- Last 48 hours news
"""

from datetime import UTC, date, datetime
import os

from dotenv import load_dotenv
import requests

from ..schema import News
from ..utils import format_date

load_dotenv()


def get_news_newsdata(
    query: str,
) -> list[News]:
    """Get the last 48 hours of financial news using NewsData."""
    params = {
        "apikey": os.getenv("NEWSDATA_API_KEY"),
        "q": f"{query}",
        "country": "us",
        "language": "en",
        "category": "business,breaking,politics,technology,top",
        "prioritydomain": "top",
        "video": 0,
        "removeduplicate": 1,
        "sort": "relevancy",
    }
    response = requests.get(
        url="https://newsdata.io/api/1/latest",
        params=params,
        timeout=60,
    )
    response.raise_for_status()
    news_list = response.json().get("results", [])

    return [
        News(
            title=news["title"],
            url=news["link"],
            date=(date_str := format_date(datetime.fromisoformat(news["pubDate"].replace("Z", "+00:00")))),
            days_ago=(datetime.now(UTC).date() - date.fromisoformat(date_str)).days,
        )
        for news in news_list
    ]
