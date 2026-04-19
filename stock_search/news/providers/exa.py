"""Exa
Playground: https://dashboard.exa.ai/playground/search
Documentation: https://docs.exa.ai/reference/search
- $5 per 1000 results when max results is up to 25
- Other LLM analysis costs apply, so disabled here
"""

import asyncio
from datetime import UTC, datetime, timedelta
import os

import httpx

from ...models.schemas import NewsArticle, NewsMetadata
from ...utils import extract_domain, format_date, format_iso_z, get_days_ago, parse_date, parse_ticker

DEFAULT_TIMEOUT_SEC = 60
EXA_MAX_RESULTS = 25


async def get_news_exa_async(
    query: str,
    n_days: int = 3,
    max_results: int = EXA_MAX_RESULTS,
    *,
    client: httpx.AsyncClient,
) -> list[NewsArticle]:
    """Search Exa for news results and return raw payload items."""
    bounded_max_results = min(max_results, EXA_MAX_RESULTS)
    payload = {
        "query": parse_ticker(query),
        "category": "news",
        "num_results": bounded_max_results,
        "start_published_date": format_iso_z(datetime.now(UTC) - timedelta(days=n_days)),
        "end_published_date": format_iso_z(datetime.now(UTC)),
        "type": "auto",
        "user_location": "US",
    }
    headers = {
        "Authorization": f"Bearer {os.getenv('EXA_API_KEY')}",
        "Content-Type": "application/json",
    }
    response = await client.post(
        url="https://api.exa.ai/search",
        json=payload,
        headers=headers,
    )
    response.raise_for_status()
    results = response.json().get("results", [])

    news_list = []
    fetched_at = datetime.now(UTC).isoformat()
    for result in results:
        dt = parse_date(result["publishedDate"])
        url = result["url"]
        news_list.append(
            NewsArticle(
                title=result["title"],
                url=url,
                date=format_date(dt),
                days_ago=get_days_ago(dt),
                summary="[FAILED TO FETCH]",
                metadata=NewsMetadata(
                    provider="exa",
                    source_domain=extract_domain(url),
                    published_at=dt.astimezone(UTC).isoformat(),
                    fetched_at=fetched_at,
                ),
            )
        )
    return news_list


def get_news_exa(
    query: str,
    n_days: int = 3,
    max_results: int = EXA_MAX_RESULTS,
) -> list[NewsArticle]:
    """Search Exa for news results and return raw payload items."""

    async def _fetch() -> list[NewsArticle]:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_SEC) as client:
            return await get_news_exa_async(
                query=query,
                n_days=n_days,
                max_results=max_results,
                client=client,
            )

    return asyncio.run(_fetch())
