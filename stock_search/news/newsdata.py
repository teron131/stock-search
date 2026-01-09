"""NewsData
Playground: https://newsdata.io/search-dashboard
Documentation: https://newsdata.io/documentation#latest-news
- Free
- 200 credits per day
- 10 articles per credit
- Last 48 hours news
"""

import os

from dotenv import load_dotenv
import requests

from ..schema import News
from ..utils import format_date, get_days_ago, parse_date

load_dotenv()


def get_news_newsdata(
    ticker: str,
) -> list[News]:
    """Get the last 48 hours of financial news using NewsData."""
    params = {
        "apikey": os.getenv("NEWSDATA_API_KEY"),
        "q": ticker,
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

    results = []
    for news in news_list:
        dt = parse_date(news["pubDate"])
        results.append(
            News(
                title=news["title"],
                url=news["link"],
                date=format_date(dt),
                days_ago=get_days_ago(dt),
                summary=f"[TRUNCATED] {news['description']}",
            )
        )
    return results
