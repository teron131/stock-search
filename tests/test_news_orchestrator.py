import asyncio
from datetime import timedelta

from stock_search.cache import TieredCache
from stock_search.models.schemas import NewsAnalysis, NewsArticle, NewsMetadata
import stock_search.news.orchestrator as news_orchestrator


def _make_news(*, title: str, url: str, days_ago: int) -> NewsArticle:
    return NewsArticle(
        title=title,
        url=url,
        date="2026-04-17",
        days_ago=days_ago,
        metadata=NewsMetadata(provider="test"),
    )


def test_finalize_news_feed_filters_non_english_unicode_articles() -> None:
    english_news = _make_news(
        title="TSMC plans sub-1nm pilot production in 2029",
        url="https://example.com/english",
        days_ago=0,
    ).model_copy(
        update=NewsAnalysis(
            summary="TSMC is preparing an early pilot line for sub-1nm production.",
            relevancy="high",
            category="industry_news",
            sentiment="neutral",
        ).model_dump()
    )
    accented_non_english_news = _make_news(
        title="TSMC du kien san xuat thu nghiem chip duoi 1nm vao nam 2029",
        url="https://example.com/accented-non-english",
        days_ago=0,
    ).model_copy(
        update=NewsAnalysis(
            summary="TSMC dự kiến sản xuất thử nghiệm chip dưới 1nm bắt đầu vào năm 2029.",
            relevancy="high",
            category="industry_news",
            sentiment="neutral",
        ).model_dump()
    )

    result = news_orchestrator._finalize_news_feed([english_news, accented_non_english_news])

    assert [item.url for item in result] == [
        "https://example.com/english",
    ]


def test_get_news_async_tolerates_provider_failures_and_preserves_selection(monkeypatch) -> None:
    deduped_inputs: list[str] = []
    exa_called = False

    async def fake_newsdata(*, query: str, client) -> list[NewsArticle]:
        assert query == "NVDA"
        return [
            _make_news(title="Primary A", url="https://example.com/a", days_ago=2),
            _make_news(title="Filter Low", url="https://example.com/b", days_ago=0),
        ]

    async def fake_massive(*, ticker: str, n_days: int, max_results: int, client) -> list[NewsArticle]:
        raise RuntimeError("massive offline")

    async def fake_exa(*, query: str, n_days: int, max_results: int, client) -> list[NewsArticle]:
        nonlocal exa_called
        exa_called = True
        return [_make_news(title="Duplicate A", url="https://example.com/a?utm_source=test", days_ago=1)]

    async def fake_newsapi(*, query: str, n_days: int, max_results: int, client) -> list[NewsArticle]:
        return [_make_news(title="Keep Medium", url="https://example.com/c", days_ago=1)]

    def fake_yfinance(*, ticker: str, max_results: int) -> list[NewsArticle]:
        return [_make_news(title="Filter Failed", url="https://example.com/d", days_ago=3)]

    def fake_analyze_news(ticker: str, news_list: list[NewsArticle]) -> list[NewsAnalysis]:
        assert ticker == "NVDA"
        deduped_inputs.extend(news.url for news in news_list)
        return [
            NewsAnalysis(summary="Keep this", relevancy="high", category="company_news", sentiment="bullish"),
            NewsAnalysis(summary="Low relevance", relevancy="low", category="market_news", sentiment="neutral"),
            NewsAnalysis(summary="Useful update", relevancy="medium", category="market_news", sentiment="neutral"),
            NewsAnalysis(summary="[FAILED TO FETCH]", relevancy="high", category="other", sentiment="neutral"),
        ]

    monkeypatch.setattr(news_orchestrator, "get_news_newsdata_async", fake_newsdata)
    monkeypatch.setattr(news_orchestrator, "get_news_massive_async", fake_massive)
    monkeypatch.setattr(news_orchestrator, "get_news_exa_async", fake_exa)
    monkeypatch.setattr(news_orchestrator, "get_news_newsapi_async", fake_newsapi)
    monkeypatch.setattr(news_orchestrator, "get_news_yfinance", fake_yfinance)
    monkeypatch.setattr(news_orchestrator, "_analyze_news", fake_analyze_news)

    result = asyncio.run(news_orchestrator.get_news_async("NVDA"))

    assert exa_called is True
    assert deduped_inputs == [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
        "https://example.com/d",
    ]
    assert [item.title for item in result] == ["Keep Medium", "Primary A"]


def test_analyze_news_reuses_cached_url_analysis(monkeypatch) -> None:
    webloader_calls: list[list[str]] = []
    invoke_calls: list[str] = []

    class FakeModel:
        def with_structured_output(self, _schema):
            return self

        def invoke(self, prompt: str) -> NewsAnalysis:
            invoke_calls.append(prompt)
            return NewsAnalysis(
                summary="Cached summary",
                relevancy="high",
                category="analysis",
                sentiment="bullish",
            )

    def fake_webloader(urls: list[str]) -> list[str]:
        webloader_calls.append(urls)
        return ["Article body"] * len(urls)

    monkeypatch.setattr(
        news_orchestrator,
        "ANALYSIS_CACHE",
        TieredCache[NewsAnalysis](ttl_seconds=3600, stale_seconds=7200, failure_cooldown_seconds=60),
    )
    monkeypatch.setattr(news_orchestrator, "ChatOpenAI", lambda **kwargs: FakeModel())
    monkeypatch.setattr(news_orchestrator, "webloader", fake_webloader)
    monkeypatch.setattr(news_orchestrator, "tqdm", lambda items, **kwargs: items)

    first_batch = [
        _make_news(title="A", url="https://example.com/a?utm_source=alpha", days_ago=0),
    ]
    second_batch = [
        _make_news(title="A", url="https://example.com/a?utm_source=beta", days_ago=0),
    ]

    first_result = news_orchestrator._analyze_news("NVDA", first_batch)
    second_result = news_orchestrator._analyze_news("NVDA", second_batch)

    assert first_result[0].summary == "Cached summary"
    assert second_result[0].summary == "Cached summary"
    assert webloader_calls == [["https://example.com/a?utm_source=alpha"]]
    assert len(invoke_calls) == 1


def test_get_news_async_skips_exa_when_primary_providers_have_enough_results(monkeypatch) -> None:
    async def fake_newsdata(*, query: str, client) -> list[NewsArticle]:
        assert query == "NVDA"
        return [
            _make_news(title="A", url="https://example.com/a", days_ago=0),
            _make_news(title="B", url="https://example.com/b", days_ago=0),
        ]

    async def fake_massive(*, ticker: str, n_days: int, max_results: int, client) -> list[NewsArticle]:
        assert ticker == "NVDA"
        return [_make_news(title="C", url="https://example.com/c", days_ago=1)]

    async def fake_newsapi(*, query: str, n_days: int, max_results: int, client) -> list[NewsArticle]:
        assert query == "NVDA"
        return [_make_news(title="D", url="https://example.com/d", days_ago=2)]

    def fake_yfinance(*, ticker: str, max_results: int) -> list[NewsArticle]:
        assert ticker == "NVDA"
        return []

    async def fake_exa(*, query: str, n_days: int, max_results: int, client) -> list[NewsArticle]:
        raise AssertionError("Exa should not run when primary providers already have enough items")

    def fake_analyze_news(ticker: str, news_list: list[NewsArticle]) -> list[NewsAnalysis]:
        assert ticker == "NVDA"
        return [NewsAnalysis(summary=f"summary-{idx}", relevancy="high", category="company_news", sentiment="neutral") for idx, _news in enumerate(news_list)]

    monkeypatch.setattr(news_orchestrator, "get_news_newsdata_async", fake_newsdata)
    monkeypatch.setattr(news_orchestrator, "get_news_massive_async", fake_massive)
    monkeypatch.setattr(news_orchestrator, "get_news_newsapi_async", fake_newsapi)
    monkeypatch.setattr(news_orchestrator, "get_news_yfinance", fake_yfinance)
    monkeypatch.setattr(news_orchestrator, "get_news_exa_async", fake_exa)
    monkeypatch.setattr(news_orchestrator, "_analyze_news", fake_analyze_news)

    result = asyncio.run(news_orchestrator.get_news_async("NVDA", max_results=4))

    assert [item.url for item in result] == [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
        "https://example.com/d",
    ]


def test_get_news_async_skips_rate_limited_provider(monkeypatch) -> None:
    massive_called = False

    async def fake_newsdata(*, query: str, client) -> list[NewsArticle]:
        assert query == "NVDA"
        return [_make_news(title="A", url="https://example.com/a", days_ago=0)]

    async def fake_massive(*, ticker: str, n_days: int, max_results: int, client) -> list[NewsArticle]:
        nonlocal massive_called
        massive_called = True
        return [_make_news(title="B", url="https://example.com/b", days_ago=0)]

    async def fake_newsapi(*, query: str, n_days: int, max_results: int, client) -> list[NewsArticle]:
        assert query == "NVDA"
        return [_make_news(title="C", url="https://example.com/c", days_ago=1)]

    def fake_yfinance(*, ticker: str, max_results: int) -> list[NewsArticle]:
        assert ticker == "NVDA"
        return []

    async def fake_exa(*, query: str, n_days: int, max_results: int, client) -> list[NewsArticle]:
        return [_make_news(title="D", url="https://example.com/d", days_ago=2)]

    def fake_analyze_news(ticker: str, news_list: list[NewsArticle]) -> list[NewsAnalysis]:
        assert ticker == "NVDA"
        return [NewsAnalysis(summary=f"summary-{idx}", relevancy="high", category="company_news", sentiment="neutral") for idx, _news in enumerate(news_list)]

    monkeypatch.setattr(news_orchestrator, "get_news_newsdata_async", fake_newsdata)
    monkeypatch.setattr(news_orchestrator, "get_news_massive_async", fake_massive)
    monkeypatch.setattr(news_orchestrator, "get_news_newsapi_async", fake_newsapi)
    monkeypatch.setattr(news_orchestrator, "get_news_yfinance", fake_yfinance)
    monkeypatch.setattr(news_orchestrator, "get_news_exa_async", fake_exa)
    monkeypatch.setitem(
        news_orchestrator.PROVIDER_RATE_LIMITERS,
        "massive",
        news_orchestrator.ProviderRequestLimiter(
            news_orchestrator.ProviderRateLimit(max_requests=0, window=timedelta(minutes=1)),
        ),
    )
    monkeypatch.setattr(news_orchestrator, "_analyze_news", fake_analyze_news)

    result = asyncio.run(news_orchestrator.get_news_async("NVDA", max_results=4))

    assert massive_called is False
    assert [item.url for item in result] == [
        "https://example.com/a",
        "https://example.com/c",
        "https://example.com/d",
    ]
