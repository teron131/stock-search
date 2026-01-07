from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
import os
from urllib.parse import parse_qsl, urlparse, urlunparse

from docling.document_converter import DocumentConverter
from dotenv import load_dotenv
from langchain_core.prompts import PromptTemplate
import requests
import yfinance as yf

from .openrouter import ChatOpenRouter
from .schema import News, NewsAnalysis
from .utils import iso_to_str, n_days_ago, timestamp_to_str

load_dotenv()

FAST_LLM = os.getenv("FAST_LLM", "google/gemini-3-flash-preview")


def webloader_docling(urls: list[str]) -> list[str | None]:
    """Load and process website content from URLs into markdown."""
    converter = DocumentConverter()

    def _convert(url: str) -> str | None:
        try:
            return converter.convert(url).document.export_to_markdown()
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=min(len(urls), os.cpu_count())) as executor:
        return list(executor.map(_convert, urls))


def _analyze_news(ticker: str, news_list: list[News]) -> list[NewsAnalysis]:
    """Run LLM analysis over article URLs, preferring docling web loader."""

    llm = ChatOpenRouter(
        model=FAST_LLM,
        temperature=0,
        reasoning_effort="low",
    ).with_structured_output(NewsAnalysis)

    prompt_template = PromptTemplate(
        template="""Use the provided article content only. Do not use web search.
Describe the news with details and numbers mentioned clearly and concretely.
No meta-language.
Exclude garbage and ads.
Set relevancy by how directly it impacts {ticker}:
- high = directly about {ticker} (earnings, guidance, major product, regulation)
- medium = same sector/competitors/macro with indirect impact
- low = general market noise; subjective analyst opinions without objective new facts
Relevancy rules:
- high only if {ticker} is the primary subject (headline + article focus)
- market wraps and broad sector commentary default to low unless {ticker} is a primary driver
Sentiment:
- bullish if clearly positive for {ticker}
- bearish if clearly negative
- neutral if mixed or unclear; insider selling is neutral unless unusually large, illegal, or clearly adverse
Subjective analysis/opinion defaults to neutral sentiment unless objective new facts clearly support a direction.
If the article text does not mention {ticker}, set relevancy to low, sentiment to neutral, and summary to a brief note that no relevant content was found.
Choose the best category for the primary focus:
- company_news: directly about the company
- earnings: financial results and guidance
- analyst_rating: changes in analyst coverage/targets
- industry_news: sector-wide news
- market_news: general stock market updates
- macro_economics: economic data and policy
- analysis: deep dives or opinion pieces
- other: anything else

{title}
{text}""",
        input_variables=["ticker", "title", "text"],
    )

    fallback = NewsAnalysis(summary="Content unavailable or invalid URL.")
    urls = [news.url for news in news_list]
    documents = webloader_docling(urls)
    results: list[NewsAnalysis] = [fallback] * len(news_list)
    prompts: list[str] = []
    prompt_indices: list[int] = []
    for idx, (news, article_text) in enumerate(zip(news_list, documents, strict=True)):
        if not article_text:
            continue

        prompts.append(
            prompt_template.format(
                ticker=ticker,
                title=news.title,
                text=article_text,
            )
        )
        prompt_indices.append(idx)

    if prompts:
        responses = llm.batch(prompts, config={"max_concurrency": len(prompts)})
        for idx, response in zip(prompt_indices, responses, strict=True):
            results[idx] = response

    return results


def _process_articles(ticker: str, news_list: list[News]) -> list[News]:
    """Process articles by analyzing their URLs and applying LLM analysis.

    Args:
        news_list (list[News]): List of News objects with title, url, and date

    Returns:
        list[News]: List of News objects with formatted analysis content
    """
    if not news_list:
        return []

    return [
        news.model_copy(
            update=analysis.model_dump(),
        )
        for news, analysis in zip(
            news_list,
            _analyze_news(ticker, news_list),
            strict=True,
        )
    ]


def _days_ago(date_str: str) -> int | None:
    """Return the day delta from today for a YYYY-MM-DD string."""
    published = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=UTC)
    return (datetime.now(UTC).date() - published.date()).days


def _normalize_url(url: str) -> str:
    """Normalize URLs for deduping across sources."""
    parsed = urlparse(url)
    netloc = parsed.netloc.lower()
    path = parsed.path.rstrip("/")
    query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if not key.startswith("utm_")]
    normalized = parsed._replace(
        netloc=netloc,
        path=path,
        query="&".join(f"{k}={v}" for k, v in query),
    )
    return urlunparse(normalized)


def _get_news_yfinance(query: str, max_results: int = 10) -> list[News]:
    """Get news about a given stock ticker using Yahoo Finance."""
    raw_news = yf.Search(query=query, max_results=max_results).news
    if not raw_news:
        return []

    return [
        News(
            title=item["title"],
            url=item["link"],
            date=(date_str := timestamp_to_str(item["providerPublishTime"])),
            days_ago=_days_ago(date_str),
        )
        for item in raw_news
    ]


def _get_news_api(
    ticker: str,
    n_days: int = 3,
    max_results: int = 10,
) -> list[News]:
    """Get financial news using NewsAPI."""
    url = "https://newsapi.org/v2/everything"
    params = {
        "q": (
            f"{ticker} AND (stock OR shares OR market OR finance OR invest OR trade "
            "OR price OR analyst OR earnings OR guidance OR revenue OR profit OR "
            "upgrade OR downgrade OR target OR dividend OR buyback OR SEC OR "
            "regulatory OR merger OR acquisition OR lawsuit OR recall)"
        ),
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

    return [
        News(
            title=article["title"],
            url=article["url"],
            date=(date_str := iso_to_str(article["publishedAt"])),
            days_ago=_days_ago(date_str),
        )
        for article in raw_articles
    ]


def get_news(
    ticker: str,
    n_days: int = 3,
    max_results: int = 10,
) -> list[News]:
    """Fetch news from Yahoo Finance and NewsAPI, dedupe by URL, then analyze."""
    sources = _get_news_yfinance(
        ticker,
        max_results=max_results,
    ) + _get_news_api(
        ticker,
        n_days=n_days,
        max_results=max_results,
    )
    deduped: dict[str, News] = {}
    for item in sources:
        key = _normalize_url(item.url)
        if key not in deduped:
            deduped[key] = item
    return _process_articles(ticker, list(deduped.values()))
