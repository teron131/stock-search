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
                """The following content is a raw webscraped article. Extract and clean the main article content, then analyze its sentiment.

CONTENT CLEANING - KEEP:
- Main article title and content
- Publication date and author (if present)
- Main content of the article

CONTENT CLEANING - REMOVE:
- Meaningless text for formatting and structures
- Navigation menus and headers
- Advertisements and promotional content
- Cookie notices and pop-ups
- Social media buttons and related links
- Comments sections
- Footer content and site-wide elements

SENTIMENT ANALYSIS:
- Analyze the overall tone and sentiment of the article content
- Consider the language used, context, and implications
- Classify as positive, neutral, or negative based on the overall message

Return the clean, readable article content in markdown format along with the sentiment classification.""",
            ),
            ("human", "{content}"),
        ]
    )

    chain = prompt | structured_llm

    # Batch process the content
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

    # Filter out None results and build final articles
    final_articles = [
        News(
            title=article.title,
            url=article.url,
            date=article.date,
            content=formatted_content[i].content,
            sentiment=formatted_content[i].sentiment,
        )
        for i, (article, _) in enumerate(filtered_articles)
        if formatted_content[i] is not None
    ]

    return final_articles


def get_news_yfinance(query: str, max_results: int = 10) -> list[News]:
    """Search for news articles about a given stock ticker symbol.

    Args:
        query (str): The stock ticker symbol to search for

    Returns:
        list[News]: A list of News objects containing news article information
    """
    raw_articles = yf.Search(query=query, max_results=max_results).news
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


def get_news_api(
    query: str,
    n_days: int = 2,
    max_results: int = 10,
) -> list[News]:
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
        "pageSize": max_results,
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
