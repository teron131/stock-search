from datetime import UTC, date, datetime

import yfinance as yf

from ..schema import News
from ..utils import format_date


def get_news_yfinance(
    query: str,
    max_results: int = 10,
) -> list[News]:
    """Get news about a given stock ticker using Yahoo Finance."""
    raw_news = yf.Search(query=query, max_results=max_results).news
    if not raw_news:
        return []

    return [
        News(
            title=item["title"],
            url=item["link"],
            date=(date_str := format_date(datetime.fromtimestamp(item["providerPublishTime"], UTC))),
            days_ago=(datetime.now(UTC).date() - date.fromisoformat(date_str)).days,
        )
        for item in raw_news
    ]
