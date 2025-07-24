import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Literal

import requests
import yfinance as yf
from docling.document_converter import DocumentConverter
from dotenv import load_dotenv
from langchain.prompts import ChatPromptTemplate
from langchain_google_genai import ChatGoogleGenerativeAI
from pydantic import BaseModel, Field

from .schema import News

load_dotenv()


class ContentSentiment(BaseModel):
    """Structured output for cleaned content with sentiment analysis."""

    content: str = Field(description="Clean, readable article content in markdown format")
    sentiment: Literal["positive", "neutral", "negative"] = Field(description="Overall sentiment of the article")


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


def llm_formatter(content_list: list[str]) -> list[ContentSentiment]:
    """Format a list of content using LLM with sentiment analysis.

    Args:
        content_list (list[str]): A list of content to format

    Returns:
        list[ContentSentiment]: A list of formatted content with sentiment analysis
    """
    llm = ChatGoogleGenerativeAI(
        model=os.getenv("FAST_LLM"),
        temperature=0,
        api_key=os.getenv("GEMINI_API_KEY"),
        # base_url="https://openrouter.ai/api/v1",
    )

    # Create structured LLM (Gemini doesn't use function_calling method)
    structured_llm = llm.with_structured_output(ContentSentiment)

    prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                "Clean the article content by removing navigation, ads, and formatting elements. Keep only the main title, content, date, and author. Analyze sentiment as positive, neutral, or negative. Return clean markdown content with sentiment.",
            ),
            ("human", "{content}"),
        ]
    )

    chain = prompt | structured_llm

    results = chain.batch([{"content": content} for content in content_list])
    return results


def _process_articles_with_llm(articles: list[News]) -> list[News]:
    """Process articles by loading content, filtering empty content, and applying LLM formatting.

    Args:
        articles (list[News]): List of News objects with title, url, and date

    Returns:
        list[News]: List of News objects with formatted content
    """
    if not articles:
        return []

    # Load content from URLs concurrently
    with ThreadPoolExecutor(max_workers=min(len(articles), os.cpu_count())) as executor:
        futures = [executor.submit(webloader, article.url) for article in articles]
        news_content = [future.result() for future in futures]

    # Filter out articles with empty content
    filtered_articles = [(article, content) for article, content in zip(articles, news_content) if content.strip()]  # Filter out empty or whitespace-only content

    if not filtered_articles:
        return []

    # Extract content for LLM formatting
    content_list = [content for _, content in filtered_articles]

    # Apply LLM formatting to all content concurrently
    formatted_content = llm_formatter(content_list)

    return [
        News(
            title=article.title,
            url=article.url,
            date=article.date,
            content=formatted_content[i].content,
            sentiment=formatted_content[i].sentiment,
        )
        for i, (article, _) in enumerate(filtered_articles)
    ]


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

    return _process_articles_with_llm(articles)


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

    return _process_articles_with_llm(articles)
