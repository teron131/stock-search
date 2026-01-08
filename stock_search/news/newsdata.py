"""NewsData
Playground: https://newsdata.io/search-dashboard
Documentation: https://newsdata.io/documentation#latest-news
- Free
- 200 credits per day
- 10 articles per credit
"""

import os

from dotenv import load_dotenv
import requests

load_dotenv()


def get_news_newsdata(
    query: str,
) -> list[dict]:
    """Get financial news using NewsData."""
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
    return response.json().get("results", [])
