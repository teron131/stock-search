"""NewsAPI
Documentation: https://newsapi.org/docs/endpoints/everything
- Free
- 24 hours delay
- 100 requests per day
- Max 100 results per query
"""

import asyncio
from datetime import UTC, datetime, timedelta
import os

from dotenv import load_dotenv
import httpx

from ...models.schemas import NewsArticle, NewsMetadata
from ...utils import extract_domain, format_date, get_days_ago, parse_date, parse_ticker

load_dotenv()

DEFAULT_TIMEOUT_SEC = 60
NEWSAPI_MAX_RESULTS = 100


async def get_news_newsapi_async(
    query: str,
    n_days: int = 3,
    max_results: int = 25,
    *,
    client: httpx.AsyncClient,
) -> list[NewsArticle]:
    """Get financial news using NewsAPI."""
    bounded_max_results = min(max_results, NEWSAPI_MAX_RESULTS)
    params = {
        "apiKey": os.getenv("NEWS_API_KEY"),
        "q": parse_ticker(query),
        "from": (datetime.now(UTC) - timedelta(days=n_days)).strftime("%Y-%m-%d"),
        "to": (datetime.now(UTC) - timedelta(days=1)).strftime("%Y-%m-%d"),
        "language": "en",
        "sortBy": "popularity",
        "pageSize": bounded_max_results,
    }
    response = await client.get(
        url="https://newsapi.org/v2/everything",
        params=params,
    )
    response.raise_for_status()
    results = response.json().get("articles", [])

    news_list = []
    fetched_at = datetime.now(UTC).isoformat()
    for result in results:
        dt = parse_date(result["publishedAt"])
        url = result["url"]
        news_list.append(
            NewsArticle(
                title=result["title"],
                url=url,
                date=format_date(dt),
                days_ago=get_days_ago(dt),
                summary=f"[TRUNCATED] {result['description']}",
                metadata=NewsMetadata(
                    provider="newsapi",
                    source_domain=extract_domain(url),
                    published_at=dt.astimezone(UTC).isoformat(),
                    fetched_at=fetched_at,
                ),
            )
        )
    return news_list


def get_news_newsapi(
    query: str,
    n_days: int = 3,
    max_results: int = 25,
) -> list[NewsArticle]:
    """Get financial news using NewsAPI."""

    async def _fetch() -> list[NewsArticle]:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_SEC) as client:
            return await get_news_newsapi_async(
                query=query,
                n_days=n_days,
                max_results=max_results,
                client=client,
            )

    return asyncio.run(_fetch())
