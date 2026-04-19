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

from ...models.schemas import NewsArticle, NewsMetadata
from ...utils import extract_domain, format_date, get_days_ago, parse_date

load_dotenv()

SENTIMENT_MAP = {
    "positive": "bullish",
    "neutral": "neutral",
    "negative": "bearish",
}
DEFAULT_TIMEOUT_SEC = 60


async def get_news_massive_async(
    ticker: str,
    n_days: int = 3,
    max_results: int = 25,
    *,
    client: httpx.AsyncClient,
) -> list[NewsArticle]:
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
    fetched_at = datetime.now(UTC).isoformat()
    for result in results:
        dt = parse_date(result["published_utc"])
        insights = result.get("insights", [{}])
        sentiment = SENTIMENT_MAP.get(insights[0].get("sentiment"), "neutral")
        url = result["article_url"]
        news_list.append(
            NewsArticle(
                title=result["title"],
                url=url,
                date=format_date(dt),
                days_ago=get_days_ago(dt),
                summary=result.get("description", "[FAILED TO FETCH]"),
                sentiment=sentiment,
                metadata=NewsMetadata(
                    provider="massive",
                    source_domain=extract_domain(url),
                    published_at=dt.astimezone(UTC).isoformat(),
                    fetched_at=fetched_at,
                ),
            )
        )
    return news_list


def get_news_massive(
    ticker: str,
    n_days: int = 3,
    max_results: int = 25,
) -> list[NewsArticle]:
    """Get financial news using Massive API."""

    async def _fetch() -> list[NewsArticle]:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_SEC) as client:
            return await get_news_massive_async(
                ticker=ticker,
                n_days=n_days,
                max_results=max_results,
                client=client,
            )

    return asyncio.run(_fetch())
