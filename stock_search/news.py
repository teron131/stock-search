from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
import os

from dotenv import load_dotenv
import requests
import yfinance as yf

from .openrouter import ChatOpenRouter
from .schema import News, NewsAnalysis

load_dotenv()


def _news_webloader(url: str) -> NewsAnalysis:
    """Load and process the content of a website from URL using LLM with web search.

    Args:
        url (str): The URL of the website to load

    Returns:
        str: Summarized content of the website
    """
    llm = ChatOpenRouter(
        model="google/gemini-2.5-flash-lite",
        temperature=0,
        reasoning_effort="minimal",
        web_search=True,
        web_search_max_results=1,
    ).with_structured_output(NewsAnalysis)
    response: NewsAnalysis = llm.invoke(f"{url}")
    return response


def _process_articles_with_llm(news_list: list[News]) -> list[News]:
    """Process articles by loading content, filtering empty content, and applying LLM formatting.

    Args:
        articles (list[News]): List of News objects with title, url, and date

    Returns:
        list[News]: List of News objects with formatted content
    """
    if not news_list:
        return []

    # Load content from URLs concurrently
    with ThreadPoolExecutor(max_workers=min(len(news_list), os.cpu_count())) as executor:
        futures = [executor.submit(_news_webloader, news.url) for news in news_list]
        news_analysis = [future.result() for future in futures]

    # Filter out articles with empty content and build final articles
    final_news_list = []
    for news, analysis in zip(news_list, news_analysis, strict=True):
        if analysis.summary:
            # Calculate relevance based on number of tickers
            num_tickers = len(analysis.tickers)
            if num_tickers == 0:
                relevance = "irrelevant"
            elif num_tickers <= 5:
                relevance = "strong"
            elif num_tickers > 5 and num_tickers <= 10:
                relevance = "medium"
            else:
                relevance = "weak"

            # Update analysis with calculated relevance
            analysis_data = analysis.model_dump()
            analysis_data["relevance"] = relevance

            final_news_list.append(news.model_copy(update=analysis_data))

    return final_news_list


def get_news_yfinance(query: str, max_results: int = 10) -> list[News]:
    """Search for news about a given stock ticker symbol.

    Args:
        query (str): The stock ticker symbol to search for

    Returns:
        list[News]: A list of News objects containing news information
    """
    raw_articles = yf.Search(query=query, max_results=max_results).news
    if not raw_articles:
        return []

    articles = [
        News(
            title=article["title"],
            url=article["link"],
            date=datetime.fromtimestamp(article["providerPublishTime"], UTC).strftime("%Y-%m-%d %H:%M:%S"),
        )
        for article in raw_articles
    ]

    return _process_articles_with_llm(articles)


def get_news_api(
    ticker: str,
    n_days: int = 3,
    max_results: int = 10,
) -> list[News]:
    """Get the financial news for a given query and number of days.

    Args:
        ticker (str): The ticker symbol to search for.
        n_days (int): The number of days to search for.

    Returns:
        list[dict]: A list of dictionaries containing the news.
    """
    url = "https://newsapi.org/v2/everything"
    now = datetime.now(UTC)
    params = {
        "q": f"{ticker} AND (stock OR market OR finance OR invest OR trade OR price OR analyst OR Wall Street)",
        "from": (now - timedelta(days=n_days)).strftime("%Y-%m-%d"),
        "to": (now - timedelta(days=1)).strftime("%Y-%m-%d"),
        "language": "en",
        "sortBy": "popularity",
        "pageSize": max_results,
        "apiKey": os.getenv("NEWS_API_KEY"),
    }

    response = requests.get(url, params=params, timeout=60)
    response.raise_for_status()
    raw_articles = response.json()["articles"]

    if not raw_articles:
        return []

    articles = [
        News(
            title=article["title"],
            url=article["url"],
            content=article["description"],  # Truncated only from NewsAPI
            date=datetime.fromisoformat(article["publishedAt"].replace("Z", "+00:00")).strftime("%Y-%m-%d %H:%M:%S"),
        )
        for article in raw_articles
    ]

    return _process_articles_with_llm(articles)
