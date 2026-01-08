"""NewsData
Playground: https://newsdata.io/search-dashboard
Documentation: https://newsdata.io/documentation#latest-news
"""

import os

from dotenv import load_dotenv
import requests

load_dotenv()

NEWSDATA_API_KEY = os.getenv("NEWSDATA_API_KEY")


def get_news_newsdata(
    query: str,
) -> list[dict]:
    """Get financial news using NewsData."""
    params = {
        "apikey": NEWSDATA_API_KEY,
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
        "https://newsdata.io/api/1/latest",
        params=params,
        timeout=60,
    )
    return response.json().get("results")
