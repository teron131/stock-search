"""News orchestration and LLM enrichment.

Use provider APIs to discover article URLs, then load article content and analyze it with an LLM. Follow a fallback strategy because web search is not reliable for recovering specific content from a URL.
"""

import asyncio
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import logging
import math
import os
from threading import Lock
from time import perf_counter

import httpx
from langchain_core.prompts import PromptTemplate
from llm_harness.clients import ChatOpenAI
from llm_harness.tools import webloader
from tqdm import tqdm

from ..cache import TieredCache
from ..models.schemas import NewsAnalysis, NewsArticle
from ..prompts import NEWS_ANALYSIS_PROMPT
from ..utils import extract_domain, normalize_url
from .providers import (
    get_news_exa_async,
    get_news_massive_async,
    get_news_newsapi_async,
    get_news_newsdata_async,
    get_news_yfinance,
)

logger = logging.getLogger(__name__)
FAST_LLM = os.getenv("FAST_LLM")
DEFAULT_TIMEOUT_SEC = 60
MAX_ANALYSIS_WORKERS = 10
ANALYSIS_CACHE = TieredCache[NewsAnalysis](
    ttl_seconds=7 * 24 * 60 * 60,
    stale_seconds=30 * 24 * 60 * 60,
    failure_cooldown_seconds=10 * 60,
)
RELEVANCY_ORDER = {
    "high": 0,
    "medium": 1,
    "low": 2,
}
FALLBACK_SUMMARIES = (
    "[TRUNCATED]",
    "[FAILED TO FETCH]",
)


@dataclass(frozen=True)
class ProviderRateLimit:
    """One sliding-window request limit for a news provider."""

    max_requests: int
    window: timedelta


class ProviderRequestLimiter:
    """Track provider request counts inside a sliding time window."""

    def __init__(self, limit: ProviderRateLimit) -> None:
        """Initialize one limiter for a provider."""
        self._limit = limit
        self._request_times: list[datetime] = []
        self._lock = Lock()

    @staticmethod
    def _now() -> datetime:
        """Return the current timestamp in UTC."""
        return datetime.now(tz=UTC)

    def acquire(self, *, now: datetime | None = None) -> bool:
        """Reserve one request slot if the provider is still inside budget."""
        current_time = now or self._now()
        cutoff = current_time - self._limit.window
        with self._lock:
            self._request_times = [request_time for request_time in self._request_times if request_time > cutoff]
            if len(self._request_times) >= self._limit.max_requests:
                return False
            self._request_times.append(current_time)
        return True


PROVIDER_RATE_LIMITS = {
    "massive": ProviderRateLimit(
        max_requests=5,
        window=timedelta(minutes=1),
    ),
    "newsapi": ProviderRateLimit(
        max_requests=100,
        window=timedelta(days=1),
    ),
    "newsdata": ProviderRateLimit(
        max_requests=200,
        window=timedelta(days=1),
    ),
}
PROVIDER_RATE_LIMITERS = {provider_name: ProviderRequestLimiter(limit) for provider_name, limit in PROVIDER_RATE_LIMITS.items()}


def _rate_limit_provider_specs(
    ticker: str,
    provider_specs: tuple[tuple[str, object], ...],
) -> tuple[
    tuple[tuple[str, object], ...],
    dict[str, int],
]:
    """Drop providers that are currently over their request budget."""
    allowed_specs: list[tuple[str, object]] = []
    skipped_counts: dict[str, int] = {}
    for provider_name, provider_call in provider_specs:
        limiter = PROVIDER_RATE_LIMITERS.get(provider_name)
        if limiter is None or limiter.acquire():
            allowed_specs.append((provider_name, provider_call))
            continue
        close_call = getattr(provider_call, "close", None)
        if callable(close_call):
            close_call()
        logger.warning(f"[NEWS] Skipping {provider_name} for {ticker}: request budget exhausted")
        skipped_counts[provider_name] = 0
    return tuple(allowed_specs), skipped_counts


def _balance_domains(items: list[NewsArticle]) -> list[NewsArticle]:
    """Limit items per domain to ensure source diversity."""
    if not items:
        return []

    domains = [extract_domain(item.url) for item in items if item.url]
    domains = [domain for domain in domains if domain]
    if not domains:
        return items

    cap = math.ceil(len(items) / len(set(domains)))
    counts: dict[str, int] = defaultdict(int)
    kept: list[NewsArticle] = []
    for item in items:
        domain = extract_domain(item.url) if item.url else ""
        if not domain or counts[domain] < cap:
            if domain:
                counts[domain] += 1
            kept.append(item)
    return kept


def _dedupe_news(items: list[NewsArticle]) -> list[NewsArticle]:
    """Deduplicate news by normalized URL or title."""
    seen: dict[str, NewsArticle] = {}
    for item in items:
        key = normalize_url(item.url) if item.url else item.title
        seen.setdefault(key, item)
    return list(seen.values())


def _split_cached_analysis(
    news_list: list[NewsArticle],
) -> tuple[list[NewsAnalysis], int, list[tuple[int, str, NewsArticle]]]:
    """Return cached analysis hits plus the uncached items that still need enrichment."""
    failed = NewsAnalysis(summary=FALLBACK_SUMMARIES[1])
    results: list[NewsAnalysis] = [failed] * len(news_list)
    cache_hits = 0
    uncached_items: list[tuple[int, str, NewsArticle]] = []

    for idx, news in enumerate(news_list):
        cache_key = normalize_url(news.url)
        cached = ANALYSIS_CACHE.get_stale(cache_key)
        if cached is not None:
            results[idx] = cached
            cache_hits += 1
            continue
        uncached_items.append((idx, cache_key, news))

    return results, cache_hits, uncached_items


def _build_analysis_batch(
    ticker: str,
    uncached_items: list[tuple[int, str, NewsArticle]],
    prompt_template: PromptTemplate,
) -> tuple[list[tuple[int, str, NewsArticle, str]], list[str]]:
    """Fetch article content and build the prompt batch for readable articles."""
    urls = [news.url for _, _, news in uncached_items]
    content_list = webloader(urls)
    readable_items = [(idx, cache_key, news, content) for (idx, cache_key, news), content in zip(uncached_items, content_list, strict=True) if content]
    prompts = [
        prompt_template.format(
            ticker=ticker,
            title=news.title,
            content=content,
        )
        for _, _, news, content in readable_items
    ]
    return readable_items, prompts


def _merge_analysis_results(
    results: list[NewsAnalysis],
    readable_items: list[tuple[int, str, NewsArticle, str]],
    responses: list[NewsAnalysis],
) -> list[NewsAnalysis]:
    """Merge new analysis results back into the full result list and update the cache."""
    for (idx, cache_key, _, _), analysis in zip(readable_items, responses, strict=True):
        results[idx] = analysis
        if not analysis.summary.startswith(FALLBACK_SUMMARIES):
            ANALYSIS_CACHE.set(cache_key, analysis)
    return results


def _collect_provider_results(
    ticker: str,
    provider_specs: tuple[tuple[str, object], ...],
    provider_results: list[list[NewsArticle] | Exception],
) -> tuple[
    list[NewsArticle],
    dict[str, int],
]:
    """Flatten successful provider results and log provider failures."""
    raw_news_list: list[NewsArticle] = []
    provider_counts: dict[str, int] = {}
    for (provider_name, _), result in zip(provider_specs, provider_results, strict=True):
        if isinstance(result, Exception):
            logger.warning(f"[NEWS] Provider failed for {ticker} via {provider_name}: {result}")
            provider_counts[provider_name] = 0
            continue
        provider_counts[provider_name] = len(result)
        raw_news_list.extend(result)
    return raw_news_list, provider_counts


async def _fetch_provider_batch(
    ticker: str,
    provider_specs: tuple[tuple[str, object], ...],
) -> tuple[
    list[NewsArticle],
    dict[str, int],
]:
    """Run one provider batch and flatten the successful results."""
    allowed_specs, skipped_counts = _rate_limit_provider_specs(
        ticker,
        provider_specs,
    )
    if not allowed_specs:
        return [], skipped_counts
    provider_results = await asyncio.gather(
        *(call for _, call in allowed_specs),
        return_exceptions=True,
    )
    raw_news_list, provider_counts = _collect_provider_results(
        ticker,
        allowed_specs,
        provider_results,
    )
    provider_counts.update(skipped_counts)
    return raw_news_list, provider_counts


def _finalize_news_feed(news_list: list[NewsArticle]) -> list[NewsArticle]:
    """Apply final feed filtering and stable ranking."""
    filtered_news_list = [news for news in news_list if not news.summary.startswith(FALLBACK_SUMMARIES) and news.relevancy != "low"]
    return sorted(
        filtered_news_list,
        key=lambda item: (
            item.days_ago if item.days_ago is not None else float("inf"),
            RELEVANCY_ORDER[item.relevancy],
        ),
    )


def _analyze_news(
    ticker: str,
    news_list: list[NewsArticle],
) -> list[NewsAnalysis]:
    """Run LLM analysis over article URLs using web loader."""
    results, cache_hits, uncached_items = _split_cached_analysis(news_list)

    if not uncached_items:
        logger.info(f"[NEWS] Analysis cache satisfied all {len(news_list)} item(s) for {ticker}")
        return results

    model = ChatOpenAI(
        model=FAST_LLM,
        temperature=0,
        reasoning_effort="low",
    ).with_structured_output(NewsAnalysis)

    prompt_template = PromptTemplate(
        template=NEWS_ANALYSIS_PROMPT,
        input_variables=["ticker", "title", "content"],
    )
    readable_items, prompts = _build_analysis_batch(ticker, uncached_items, prompt_template)

    if not readable_items:
        logger.info(f"[NEWS] No readable article content for {ticker} (cache_hits={cache_hits}, cache_misses={len(uncached_items)})")
        return results

    logger.info(f"[NEWS] Analyzing {len(prompts)} article(s) for {ticker} (cache_hits={cache_hits}, cache_misses={len(uncached_items)})")
    max_workers = min(len(prompts), MAX_ANALYSIS_WORKERS)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        responses = list(
            tqdm(executor.map(model.invoke, prompts), total=len(prompts), desc="[analyze_news] items"),
        )

    return _merge_analysis_results(results, readable_items, responses)


async def get_news_async(
    ticker: str,
    n_days: int = 3,
    max_results: int = 10,
) -> list[NewsArticle]:
    """Fetch news from multiple providers, dedupe by URL, then analyze."""
    started_at = perf_counter()
    provider_counts: dict[str, int] = {}
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_SEC) as client:
        primary_provider_specs = (
            (
                "newsdata",
                get_news_newsdata_async(
                    query=ticker,
                    client=client,
                ),
            ),
            (
                "massive",
                get_news_massive_async(
                    ticker=ticker,
                    n_days=n_days,
                    max_results=max_results,
                    client=client,
                ),
            ),
            (
                "newsapi",
                get_news_newsapi_async(
                    query=ticker,
                    n_days=n_days,
                    max_results=max_results,
                    client=client,
                ),
            ),
            (
                "yfinance",
                asyncio.to_thread(
                    get_news_yfinance,
                    ticker=ticker,
                    max_results=max_results,
                ),
            ),
        )
        raw_news_list, provider_counts = await _fetch_provider_batch(
            ticker,
            primary_provider_specs,
        )
        raw_news_list = _dedupe_news(raw_news_list)
        if len(raw_news_list) < max_results:
            exa_news_list, exa_counts = await _fetch_provider_batch(
                ticker,
                (
                    (
                        "exa",
                        get_news_exa_async(
                            query=ticker,
                            n_days=n_days,
                            max_results=max_results,
                            client=client,
                        ),
                    ),
                ),
            )
            provider_counts.update(exa_counts)
            raw_news_list = _dedupe_news(raw_news_list + exa_news_list)
        else:
            provider_counts["exa"] = 0

    news_analysis_list = await asyncio.to_thread(_analyze_news, ticker, raw_news_list)
    news_list = [
        news.model_copy(
            update=analysis.model_dump(),
        )
        for news, analysis in zip(raw_news_list, news_analysis_list, strict=True)
    ]
    news_list = _balance_domains(news_list)
    sorted_news = _finalize_news_feed(news_list)
    duration_ms = (perf_counter() - started_at) * 1000
    logger.info(
        f"[NEWS] Completed pipeline for {ticker}: "
        f"providers={provider_counts}, raw={sum(provider_counts.values())}, "
        f"deduped={len(raw_news_list)}, returned={len(sorted_news)}, duration_ms={duration_ms:.1f}"
    )
    return sorted_news


def get_news(
    ticker: str,
    n_days: int = 3,
    max_results: int = 10,
) -> list[NewsArticle]:
    """Fetch news from multiple providers, dedupe by URL, then analyze."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop and loop.is_running():
        raise RuntimeError("get_news() cannot be called from an active event loop; use get_news_async().")
    return asyncio.run(
        get_news_async(
            ticker=ticker,
            n_days=n_days,
            max_results=max_results,
        )
    )
