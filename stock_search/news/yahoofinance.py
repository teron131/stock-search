"""yfinance
Documentation: https://ranaroussi.github.io/yfinance/reference/api/yfinance.Search.html
- Free
"""

import yfinance as yf

from ..schema import News
from ..utils import format_date, get_days_ago, parse_date


def get_news_yfinance(
    ticker: str,
    max_results: int = 25,
) -> list[News]:
    """Get news about a given stock ticker using Yahoo Finance."""
    raw_news = yf.Search(query=ticker, max_results=max_results).news
    if not raw_news:
        return []

    results = []
    for item in raw_news:
        # yfinance returns UNIX timestamp
        dt = parse_date(item["providerPublishTime"])
        results.append(
            News(
                title=item["title"],
                url=item["link"],
                date=format_date(dt),
                days_ago=get_days_ago(dt),
            )
        )
    return results
