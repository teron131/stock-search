import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import requests
import yfinance as yf
from docling.document_converter import DocumentConverter
from dotenv import load_dotenv

from .schema import News

load_dotenv()


def webloader(url: str) -> str:
    """Load and process the content of a website from URL into a rich unified markdown representation.

    Args:
        url (str): The URL of the website to load

    Returns:
        str: Formatted string containing the website URL followed by the processed content
    """
    try:
        converter = DocumentConverter()
        result = converter.convert(url)
        return result.document.export_to_markdown()
    except Exception as e:
        return ""


def get_news_yfinance(query: str) -> list[News]:
    """Search for news articles about a given stock ticker symbol.

    Args:
        query (str): The stock ticker symbol to search for

    Returns:
        list[News]: A list of News objects containing news article information
    """
    raw_articles = yf.Search(query=query).news
    if not raw_articles:
        return []

    articles = [
        News(
            title=article["title"],
            url=article["link"],
            date=datetime.fromtimestamp(article["providerPublishTime"]).strftime("%Y-%m-%d %H:%M:%S"),
        )
        for article in raw_articles
    ]

    with ThreadPoolExecutor(max_workers=min(len(articles), os.cpu_count())) as executor:
        futures = [executor.submit(webloader, article.url) for article in articles]
        news_content = [future.result() for future in futures]

    return [
        News(
            title=article.title,
            url=article.url,
            date=article.date,
            content=content,
        )
        for article, content in zip(articles, news_content)
    ]


def get_news_api(query: str, n_days: int = 7) -> list[News]:
    """Get the financial news for a given query and number of days.

    Args:
        query (str): The query to search for.
        n_days (int): The number of days to search for.

    Returns:
        list[dict]: A list of dictionaries containing the news articles.
    """
    url = "https://newsapi.org/v2/everything"
    now = datetime.now()
    params = {
        "q": f"{query} AND (stock OR market OR finance OR invest OR trade OR price OR analyst OR Wall Street)",
        "from": (now - timedelta(days=n_days)).strftime("%Y-%m-%d"),
        "to": (now - timedelta(days=1)).strftime("%Y-%m-%d"),
        "language": "en",
        "sortBy": "popularity",
        "pageSize": 10,
        "apiKey": os.getenv("NEWS_API_KEY"),
    }

    response = requests.get(url, params=params)
    response.raise_for_status()
    raw_articles = response.json()["articles"]

    if not raw_articles:
        return []

    articles = [
        News(
            title=article["title"],
            url=article["url"],
            date=datetime.fromisoformat(article["publishedAt"].replace("Z", "+00:00")).strftime("%Y-%m-%d %H:%M:%S"),
        )
        for article in raw_articles
    ]

    with ThreadPoolExecutor(max_workers=min(len(articles), os.cpu_count())) as executor:
        futures = [executor.submit(webloader, article.url) for article in articles]
        news_content = [future.result() for future in futures]

    return [
        News(
            title=article.title,
            url=article.url,
            date=article.date,
            content=content,
        )
        for article, content in zip(articles, news_content)
    ]
