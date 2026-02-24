"""Massive
Documentation: https://massive.com/docs/rest/stocks/news
- Free
- 5 API Calls / Minute
"""

import asyncio
from datetime import UTC, datetime, timedelta
import os

from dotenv import load_dotenv
import httpx

from ..models.schemas import NewsItem as News
from ..utils import format_date, get_days_ago, parse_date

load_dotenv()

SENTIMENT_MAP = {
    "positive": "bullish",
    "neutral": "neutral",
    "negative": "bearish",
}

DEFAULT_TIMEOUT_S = 60


async def get_news_massive_async(
    ticker: str,
    n_days: int = 3,
    max_results: int = 25,
    *,
    client: httpx.AsyncClient,
) -> list[News]:
    """Get financial news using Massive API."""
    params = {
        "apiKey": os.getenv("MASSIVE_API_KEY"),
        "ticker": ticker,
        "published_utc.gte": (datetime.now(UTC) - timedelta(days=n_days)).isoformat(),
        "order": "desc",
        "limit": max_results,
        "sort": "published_utc",
    }
    response = await client.get(
        url="https://api.massive.com/v2/reference/news",
        params=params,
    )
    response.raise_for_status()
    results = response.json().get("results", [])

    news_list = []
    for result in results:
        dt = parse_date(result["published_utc"])
        insights = result.get("insights", [{}])
        sentiment = SENTIMENT_MAP.get(insights[0].get("sentiment"), "neutral")
        news_list.append(
            News(
                title=result["title"],
                url=result["article_url"],
                date=format_date(dt),
                days_ago=get_days_ago(dt),
                summary=result.get("description", "[FAILED TO FETCH]"),
                sentiment=sentiment,
            )
        )
    return news_list


def get_news_massive(
    ticker: str,
    n_days: int = 3,
    max_results: int = 25,
) -> list[News]:
    """Get financial news using Massive API."""

    async def _fetch() -> list[News]:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_S) as client:
            return await get_news_massive_async(
                ticker=ticker,
                n_days=n_days,
                max_results=max_results,
                client=client,
            )

    return asyncio.run(_fetch())
