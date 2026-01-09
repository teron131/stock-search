"""News analysis
Primarily idea: Use quality APIs to get the URLs, then use Docling webloader to get the text, then use a LLM to analyze the text.
Follow a fallback strategy.
CAUTION: Web search is not reliable for getting specific content from a URL.
"""

from concurrent.futures import ThreadPoolExecutor
import os

from docling.document_converter import DocumentConverter
from langchain_core.prompts import PromptTemplate

from ..openrouter import ChatOpenRouter
from ..schema import News, NewsAnalysis
from ..utils import normalize_url
from .newsapi import get_news_newsapi
from .yahoofinance import get_news_yfinance

FAST_LLM = os.getenv("FAST_LLM", "google/gemini-3-flash-preview")

ANALYSIS_PROMPT = """Describe the news with details and numbers mentioned clearly and concretely.
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
{text}"""


def webloader_docling(urls: list[str]) -> list[str | None]:
    """Load and process website content from URLs into markdown."""
    converter = DocumentConverter()

    def _convert(url: str) -> str | None:
        try:
            return converter.convert(url).document.export_to_markdown()
        except Exception:
            return None

    max_workers = min(len(urls), os.cpu_count())
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        return list(executor.map(_convert, urls))


def _analyze_news(ticker: str, news_list: list[News]) -> list[NewsAnalysis]:
    """Run LLM analysis over article URLs, preferring docling web loader."""
    llm = ChatOpenRouter(
        model=FAST_LLM,
        temperature=0,
        reasoning_effort="low",
    ).with_structured_output(NewsAnalysis)

    prompt_template = PromptTemplate(
        template=ANALYSIS_PROMPT,
        input_variables=["ticker", "title", "text"],
    )

    urls = [news.url for news in news_list]
    documents = webloader_docling(urls)

    successful = [
        (idx, news, text)
        for idx, (news, text) in enumerate(
            zip(news_list, documents, strict=True),
        )
        if text
    ]

    results: list[NewsAnalysis] = [NewsAnalysis(summary="[FAILED TO FETCH]")] * len(news_list)

    if successful:
        prompts = [prompt_template.format(ticker=ticker, title=news.title, text=text) for _, news, text in successful]

        max_concurrency = min(len(prompts), os.cpu_count())
        responses = llm.batch(
            prompts,
            config={"max_concurrency": max_concurrency},
        )
        for (idx, _, _), response in zip(successful, responses, strict=True):
            results[idx] = response

    return results


def get_news(
    ticker: str,
    n_days: int = 3,
    max_results: int = 10,
) -> list[News]:
    """Fetch news from Yahoo Finance and NewsAPI, dedupe by URL, then analyze."""
    sources = get_news_yfinance(
        query=ticker,
        max_results=max_results,
    ) + get_news_newsapi(
        query=ticker,
        n_days=n_days,
        max_results=max_results,
    )

    deduped = {normalize_url(item.url): item for item in sources}
    news_list = list(deduped.values())

    if not news_list:
        return []

    analyses = _analyze_news(ticker, news_list)
    return [
        news.model_copy(
            update=analysis.model_dump(),
        )
        for news, analysis in zip(news_list, analyses, strict=True)
    ]
