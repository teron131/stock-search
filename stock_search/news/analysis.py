"""News analysis
Primarily idea: Use quality APIs to get the URLs, then use Docling webloader to get the text, then use a LLM to analyze the text.
Follow a fallback strategy.
CAUTION: Web search is not reliable for getting specific content from a URL.
"""

from concurrent.futures import ThreadPoolExecutor
import os

from langchain_core.prompts import PromptTemplate
from tqdm import tqdm

from ..openrouter import ChatOpenRouter, webloader_docling
from ..schema import News, NewsAnalysis
from ..utils import normalize_url
from .exa import get_news_exa
from .massive import get_news_massive
from .newsapi import get_news_newsapi
from .newsdata import get_news_newsdata
from .yahoofinance import get_news_yfinance

FAST_LLM = os.getenv("FAST_LLM", "google/gemini-3-flash-preview")
FALLBACK_SUMMARIES = (
    "[TRUNCATED]",
    "[FAILED TO FETCH]",
)

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
{content}"""


def _analyze_news(
    ticker: str,
    news_list: list[News],
) -> list[NewsAnalysis]:
    """Run LLM analysis over article URLs using docling web loader."""
    if not news_list:
        return []

    failed = NewsAnalysis(summary="[FAILED TO FETCH]")
    results: list[NewsAnalysis] = [failed] * len(news_list)

    llm = ChatOpenRouter(
        model=FAST_LLM,
        temperature=0,
        reasoning_effort="low",
    ).with_structured_output(NewsAnalysis)

    prompt_template = PromptTemplate(
        template=ANALYSIS_PROMPT,
        input_variables=["ticker", "title", "content"],
    )

    # Fetch article content
    urls = [news.url for news in news_list]
    content_list = webloader_docling(urls)
    print(f"[analyze_news] Docling completed: {len(content_list)} urls")

    # Identify successful fetches and build prompts
    successes = [(i, content) for i, content in enumerate(content_list) if content]
    if not successes:
        return results

    prompts = [
        prompt_template.format(
            ticker=ticker,
            title=news_list[i].title,
            content=content,
        )
        for i, content in successes
    ]

    print(f"[analyze_news] Analyzing {len(prompts)} articles")

    def _process_prompt(prompt: str) -> NewsAnalysis:
        return llm.invoke(prompt)

    max_workers = min(len(prompts), 500)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        responses = list(
            tqdm(
                executor.map(_process_prompt, prompts),
                total=len(prompts),
                desc="[analyze_news] items",
            ),
        )

    for (idx, _), analysis in zip(successes, responses, strict=True):
        results[idx] = analysis

    return results


def get_news(
    ticker: str,
    n_days: int = 3,
    max_results: int = 10,
) -> list[News]:
    """Fetch news from multiple providers, dedupe by URL, then analyze."""
    providers = (
        lambda: get_news_newsdata(query=ticker),
        lambda: get_news_massive(ticker=ticker, n_days=n_days, max_results=max_results),
        lambda: get_news_exa(query=ticker, n_days=n_days, num_results=max_results),
        lambda: get_news_yfinance(ticker=ticker, max_results=max_results),
        lambda: get_news_newsapi(query=ticker, n_days=n_days, max_results=max_results),
    )

    sources: list[News] = []
    for fetch_fn in providers:
        try:
            sources.extend(fetch_fn())
        except Exception:
            continue

    deduped: dict[str, News] = {}
    for item in sources:
        key = normalize_url(item.url) if item.url else item.title
        if key not in deduped:
            deduped[key] = item
    news_list = list(deduped.values())

    if not news_list:
        return []

    analyses = _analyze_news(ticker, news_list)

    results: list[News] = []
    for news, analysis in zip(news_list, analyses, strict=True):
        updated = news.model_copy(update=analysis.model_dump())

        # Post processing
        if updated.summary.startswith(FALLBACK_SUMMARIES):
            continue
        if updated.relevancy == "low":
            continue
        results.append(updated)

    return results
