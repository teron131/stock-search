"""yfinance
Documentation: https://ranaroussi.github.io/yfinance/reference/api/yfinance.Search.html
- Free
"""

import yfinance as yf

from ..schemas import News
from ..utils import format_date, get_days_ago, parse_date


def get_news_yfinance(
    ticker: str,
    max_results: int = 25,
) -> list[News]:
    """Get news about a given stock ticker using Yahoo Finance."""
    results = yf.Search(query=ticker, max_results=max_results).news
    if not results:
        return []

    news_list = []
    for result in results:
        # yfinance returns UNIX timestamp
        dt = parse_date(result["providerPublishTime"])
        news_list.append(
            News(
                title=result["title"],
                url=result["link"],
                date=format_date(dt),
                days_ago=get_days_ago(dt),
                summary=result.get("description", "[FAILED TO FETCH]"),
            )
        )
    return news_list
