"""NewsData
Playground: https://newsdata.io/search-dashboard
Documentation: https://newsdata.io/documentation#latest-news
- Free
- 200 credits per day
- 10 articles per credit
- Last 48 hours news
"""

import asyncio
import os

from dotenv import load_dotenv
import httpx

from ..models.schemas import NewsItem as News
from ..utils import format_date, get_days_ago, parse_date, parse_ticker

load_dotenv()

DEFAULT_TIMEOUT_S = 60


async def get_news_newsdata_async(
    query: str,
    client: httpx.AsyncClient,
) -> list[News]:
    """Get the last 48 hours of financial news using NewsData."""
    params = {
        "apikey": os.getenv("NEWSDATA_API_KEY"),
        "q": parse_ticker(query),
        "country": "us",
        "language": "en",
        "category": "business,breaking,politics,technology,top",
        "prioritydomain": "top",
        "video": 0,
        "removeduplicate": 1,
        "sort": "relevancy",
    }
    response = await client.get(
        url="https://newsdata.io/api/1/latest",
        params=params,
    )
    response.raise_for_status()
    results = response.json().get("results", [])

    news_list = []
    for result in results:
        dt = parse_date(result["pubDate"])
        news_list.append(
            News(
                title=result["title"],
                url=result["link"],
                date=format_date(dt),
                days_ago=get_days_ago(dt),
                summary=f"[TRUNCATED] {result['description']}",
            )
        )
    return news_list


def get_news_newsdata(
    query: str,
) -> list[News]:
    """Get the last 48 hours of financial news using NewsData."""

    async def _fetch() -> list[News]:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_S) as client:
            return await get_news_newsdata_async(query=query, client=client)

    return asyncio.run(_fetch())
