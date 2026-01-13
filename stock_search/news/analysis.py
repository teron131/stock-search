"""News analysis
Primarily idea: Use quality APIs to get the URLs, then use Docling webloader to get the text, then use a LLM to analyze the text.
Follow a fallback strategy.
CAUTION: Web search is not reliable for getting specific content from a URL.
"""

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
import math
import os

from langchain_core.prompts import PromptTemplate
from tqdm import tqdm

from ..llm_harness import ChatOpenRouter, webloader
from ..prompts import NEWS_ANALYSIS_PROMPT
from ..schema import News, NewsAnalysis
from ..utils import extract_domain, normalize_url
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


def _balance_domain(items: list[News]) -> list[News]:
    """Limit items per domain to ensure source diversity."""
    if not items:
        return []

    domains = [extract_domain(item.url) for item in items if item.url]
    domains = [domain for domain in domains if domain]
    if not domains:
        return items

    cap = math.ceil(len(items) / len(set(domains)))
    counts: dict[str, int] = defaultdict(int)
    kept: list[News] = []
    for item in items:
        domain = extract_domain(item.url) if item.url else ""
        if not domain or counts[domain] < cap:
            if domain:
                counts[domain] += 1
            kept.append(item)
    return kept


def _dedupe_news(items: list[News]) -> list[News]:
    """Deduplicate news by normalized URL or title."""
    seen: dict[str, News] = {}
    for item in items:
        key = normalize_url(item.url) if item.url else item.title
        seen.setdefault(key, item)
    return list(seen.values())


def _analyze_news(
    ticker: str,
    news_list: list[News],
) -> list[NewsAnalysis]:
    """Run LLM analysis over article URLs using docling web loader."""
    failed = NewsAnalysis(summary=FALLBACK_SUMMARIES[1])
    results: list[NewsAnalysis] = [failed] * len(news_list)

    model = ChatOpenRouter(
        model=FAST_LLM,
        temperature=0,
        reasoning_effort="low",
    ).with_structured_output(NewsAnalysis)

    prompt_template = PromptTemplate(
        template=NEWS_ANALYSIS_PROMPT,
        input_variables=["ticker", "title", "content"],
    )

    # Fetch article content
    urls = [news.url for news in news_list]
    content_list = webloader(urls)

    # Identify successful fetches and build prompts
    successes = [(i, content) for i, content in enumerate(content_list) if content]
    if not successes:
        return results

    prompts = [prompt_template.format(ticker=ticker, title=news_list[i].title, content=content) for i, content in successes]

    print(f"[analyze_news] Analyzing {len(prompts)} articles")
    max_workers = min(len(prompts), 500)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        responses = list(
            tqdm(executor.map(model.invoke, prompts), total=len(prompts), desc="[analyze_news] items"),
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
        lambda: get_news_exa(query=ticker, n_days=n_days, max_results=max_results),
        lambda: get_news_yfinance(ticker=ticker, max_results=max_results),
        lambda: get_news_newsapi(query=ticker, n_days=n_days, max_results=max_results),
    )

    # Fetch from all providers
    raw_news_list: list[News] = []
    for fetch_fn in providers:
        with suppress(Exception):
            raw_news_list.extend(fetch_fn())

    # Dedupe and analyze
    raw_news_list = _dedupe_news(raw_news_list)
    news_analysis_list = _analyze_news(ticker, raw_news_list)

    # Merge analysis into news objects
    news_list = [
        news.model_copy(
            update=analysis.model_dump(),
        )
        for news, analysis in zip(raw_news_list, news_analysis_list, strict=True)
    ]

    # Balance domains
    news_list = _balance_domain(news_list)

    # Filter out fallback summaries and low relevancy
    filtered_news_list = []
    for news in news_list:
        if not news.summary.startswith(FALLBACK_SUMMARIES) and news.relevancy != "low":
            filtered_news_list.append(news)

    def sort_key(x: News) -> tuple[float, int]:
        days = x.days_ago if x.days_ago is not None else float("inf")
        relevancy_order = {"high": 0, "medium": 1, "low": 2}
        return (days, relevancy_order[x.relevancy])

    sorted_news_list = sorted(filtered_news_list, key=sort_key)

    return sorted_news_list
