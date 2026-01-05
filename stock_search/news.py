from concurrent.futures import ThreadPoolExecutor
import os

from dotenv import load_dotenv
import requests
import yfinance as yf

from .openrouter import ChatOpenRouter
from .schema import News, NewsAnalysis
from .utils import iso_to_str, n_days_ago, timestamp_to_str

load_dotenv()

# Constants
FAST_LLM = os.getenv("FAST_LLM", "google/gemini-2.5-flash-lite")


def _news_webloader(url: str) -> NewsAnalysis:
    """Load and process the content of a website from URL using LLM with web search.

    Args:
        url (str): The URL of the website to load

    Returns:
        NewsAnalysis: Summarized content and metadata of the website
    """
    llm = ChatOpenRouter(
        model=FAST_LLM,
        temperature=0,
        reasoning_effort="minimal",
        web_search=True,
        web_search_max_results=1,
    ).with_structured_output(NewsAnalysis)
    response: NewsAnalysis = llm.invoke(url)
    return response


def _process_articles_with_llm(news_list: list[News]) -> list[News]:
    """Process articles by loading content and applying LLM analysis.

    Args:
        news_list (list[News]): List of News objects with title, url, and date

    Returns:
        list[News]: List of News objects with formatted analysis content
    """
    if not news_list:
        return []

    # Load content from URLs concurrently
    max_workers = min(len(news_list), os.cpu_count() or 1)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        news_analysis = list(executor.map(_news_webloader, [news.url for news in news_list]))

    # Build final articles
    return [
        news.model_copy(
            update=analysis.model_dump(),
        )
        for news, analysis in zip(news_list, news_analysis, strict=True)
    ]


def get_news_yfinance(query: str, max_results: int = 10) -> list[News]:
    """Search for news about a given stock ticker symbol using Yahoo Finance.

    Args:
        query (str): The stock ticker symbol to search for
        max_results (int): Maximum number of results to return

    Returns:
        list[News]: A list of News objects containing news information
    """
    news_list = yf.Search(query=query, max_results=max_results).news
    if not news_list:
        return []

    news_list = [
        News(
            title=news["title"],
            url=news["link"],
            date=timestamp_to_str(news["providerPublishTime"]),
        )
        for news in news_list
    ]

    return _process_articles_with_llm(news_list)


def get_news_api(
    ticker: str,
    n_days: int = 3,
    max_results: int = 10,
) -> list[News]:
    """Get the financial news for a given query and number of days using NewsAPI.

    Args:
        ticker (str): The ticker symbol to search for.
        n_days (int): The number of days to search back.
        max_results (int): Maximum number of results to return.

    Returns:
        list[News]: A list of News objects containing the news.
    """
    url = "https://newsapi.org/v2/everything"
    params = {
        "q": f"{ticker} AND (stock OR market OR finance OR invest OR trade OR price OR analyst OR Wall Street)",
        "from": n_days_ago(n_days),
        "to": n_days_ago(1),
        "language": "en",
        "sortBy": "popularity",
        "pageSize": max_results,
        "apiKey": os.getenv("NEWS_API_KEY"),
    }

    response = requests.get(url, params=params, timeout=60)
    response.raise_for_status()
    raw_articles = response.json().get("articles", [])

    if not raw_articles:
        return []

    articles = [
        News(
            title=article["title"],
            url=article["url"],
            date=iso_to_str(article["publishedAt"]),
        )
        for article in raw_articles
    ]

    return _process_articles_with_llm(articles)
