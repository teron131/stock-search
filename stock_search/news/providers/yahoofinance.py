"""yfinance
Documentation: https://ranaroussi.github.io/yfinance/reference/api/yfinance.Search.html
- Free
"""

from datetime import UTC, datetime

import yfinance as yf

from ...models.schemas import NewsArticle, NewsMetadata
from ...utils import extract_domain, format_date, get_days_ago, parse_date


def get_news_yfinance(
    ticker: str,
    max_results: int = 25,
) -> list[NewsArticle]:
    """Get news about a given stock ticker using Yahoo Finance."""
    results = yf.Search(query=ticker, max_results=max_results).news
    if not results:
        return []

    news_list = []
    fetched_at = datetime.now(UTC).isoformat()
    for result in results:
        # yfinance returns UNIX timestamp
        dt = parse_date(result["providerPublishTime"])
        url = result["link"]
        news_list.append(
            NewsArticle(
                title=result["title"],
                url=url,
                date=format_date(dt),
                days_ago=get_days_ago(dt),
                summary=result.get("description", "[FAILED TO FETCH]"),
                metadata=NewsMetadata(
                    provider="yfinance",
                    source_domain=extract_domain(url),
                    published_at=dt.astimezone(UTC).isoformat(),
                    fetched_at=fetched_at,
                ),
            )
        )
    return news_list
