from .analysis import process_articles, webloader_docling
from .newsapi import get_news_newsapi
from .yahoofinance import get_news_yfinance
from ..schema import News
from ..utils import normalize_url

__all__ = [
    "get_news",
    "get_news_newsapi",
    "get_news_yfinance",
    "process_articles",
    "webloader_docling",
]


def get_news(
    ticker: str,
    n_days: int = 3,
    max_results: int = 10,
) -> list[News]:
    """Fetch news from Yahoo Finance and NewsAPI, dedupe by URL, then analyze."""
    sources = get_news_yfinance(
        ticker,
        max_results=max_results,
    ) + get_news_newsapi(
        ticker,
        n_days=n_days,
        max_results=max_results,
    )
    deduped: dict[str, News] = {}
    for item in sources:
        key = normalize_url(item.url)
        if key not in deduped:
            deduped[key] = item
    return process_articles(ticker, list(deduped.values()))
