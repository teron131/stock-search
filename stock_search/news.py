from datetime import UTC, datetime
import os

from docling.document_converter import DocumentConverter
from dotenv import load_dotenv
from langchain_core.prompts import PromptTemplate
import requests
import yfinance as yf

from .openrouter import ChatOpenRouter
from .schema import News, NewsAnalysis
from .utils import iso_to_str, n_days_ago, timestamp_to_str

load_dotenv()

FAST_LLM = os.getenv("FAST_LLM", "google/gemini-2.5-flash-lite")


def _load_news_markdown(urls: list[str]) -> list[str]:
    """Load article markdown for a list of URLs."""
    converter = DocumentConverter()
    results = converter.convert_all(urls)
    return [result.document.export_to_markdown() if result.document else "" for result in results]


def _analyze_news(news_markdowns: list[str]) -> list[NewsAnalysis]:
    """Run LLM analysis over article markdowns."""
    llm = ChatOpenRouter(
        model=FAST_LLM,
        temperature=0,
        reasoning_effort="low",
    ).with_structured_output(NewsAnalysis)

    prompt = PromptTemplate(
        input_variables=["markdown"],
        template="""Summarize the article clearly and concretely (no meta-language).
Set relevancy by how directly it impacts the primary subject:
- high = directly about the subject (earnings, guidance, major product, regulation)
- medium = same sector/competitors/macro with indirect impact
- low = general market noise
Sentiment:
- bullish if clearly positive for the subject
- bearish if clearly negative
- neutral if mixed or unclear
Choose the best category for the primary focus.

{markdown}""",
    )
    return llm.batch([prompt.format(markdown=markdown) for markdown in news_markdowns])


def _process_articles(news_list: list[News]) -> list[News]:
    """Process articles by loading content and applying LLM analysis.

    Args:
        news_list (list[News]): List of News objects with title, url, and date

    Returns:
        list[News]: List of News objects with formatted analysis content
    """
    if not news_list:
        return []

    urls = [news.url for news in news_list]
    news_markdowns = _load_news_markdown(urls)
    news_analysis = _analyze_news(news_markdowns)

    return [
        news.model_copy(
            update=analysis.model_dump(),
        )
        for news, analysis in zip(news_list, news_analysis, strict=True)
    ]


def _days_ago(date_str: str) -> int | None:
    """Return the day delta from today for a YYYY-MM-DD string."""
    published = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=UTC)
    return (datetime.now(UTC).date() - published.date()).days


def get_news_yfinance(query: str, max_results: int = 10) -> list[News]:
    """Search for news about a given stock ticker using Yahoo Finance.

    Args:
        query (str): The stock ticker to search for
        max_results (int): Maximum number of results to return

    Returns:
        list[News]: A list of News objects containing news information
    """
    news_list = yf.Search(query=query, max_results=max_results).news
    if not news_list:
        return []

    news_list = []
    for news in news_list:
        date_str = timestamp_to_str(news["providerPublishTime"])
        news_list.append(
            News(
                title=news["title"],
                url=news["link"],
                date=date_str,
                days_ago=_days_ago(date_str),
            )
        )

    return _process_articles(news_list)


def get_news_api(
    ticker: str,
    n_days: int = 3,
    max_results: int = 10,
) -> list[News]:
    """Get the financial news for a given query and number of days using NewsAPI.

    Args:
        ticker (str): The ticker to search for.
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

    articles = []
    for article in raw_articles:
        date_str = iso_to_str(article["publishedAt"])
        articles.append(
            News(
                title=article["title"],
                url=article["url"],
                date=date_str,
                days_ago=_days_ago(date_str),
            )
        )

    return _process_articles(articles)
