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

from ..models.schemas import NewsItem as News
from ..utils import format_date, format_iso_z, get_days_ago, parse_date, parse_ticker

DEFAULT_TIMEOUT_S = 60


async def get_news_exa_async(
    query: str,
    n_days: int = 3,
    max_results: int = 25,
    *,
    client: httpx.AsyncClient,
) -> list[News]:
    """Search Exa for news results and return raw payload items."""
    payload = {
        "query": parse_ticker(query),
        "category": "news",
        "num_results": max_results,
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
    for result in results:
        dt = parse_date(result["publishedDate"])
        news_list.append(
            News(
                title=result["title"],
                url=result["url"],
                date=format_date(dt),
                days_ago=get_days_ago(dt),
                summary="[FAILED TO FETCH]",
            )
        )
    return news_list


def get_news_exa(
    query: str,
    n_days: int = 3,
    max_results: int = 25,
) -> list[News]:
    """Search Exa for news results and return raw payload items."""

    async def _fetch() -> list[News]:
        """Fetch Exa news results for one ticker query."""
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_S) as client:
            return await get_news_exa_async(
                query=query,
                n_days=n_days,
                max_results=max_results,
                client=client,
            )

    return asyncio.run(_fetch())
