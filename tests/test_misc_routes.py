from fastapi.testclient import TestClient

import stock_search.api.app as app_module
from stock_search.api.route_paths import COLOR_STANDARDS, EVAL, REALTIME_CONFIG, STOCK_EVALUATE, STOCK_NEWS, STOCKS
import stock_search.api.routes.misc as misc_routes
from stock_search.models.schemas import NewsArticle, NewsMetadata

NEWS_ARTICLE_FIELDS = {"title", "url", "summary", "relevancy", "category", "sentiment"}
EVALUATION_FIELDS = {
    "ticker",
    "rank",
    "overall_score",
    "moat_score",
    "quality_score",
    "valuation_score",
    "upside_score",
    "market_cap_score",
    "bull_probability",
    "bear_probability",
    "price",
    "change_percent_1d",
    "rsi",
}


class FakeIndicator:
    def __init__(self, ticker: str) -> None:
        self.ticker = ticker
        self.price = 123.45
        self.change_percent_1d = 1.5
        self.rsi = 54.2


def assert_no_store(response) -> None:
    assert response.headers["cache-control"] == "no-store"


def test_root_route_serves_index_when_file_backend_is_forced(monkeypatch) -> None:
    monkeypatch.setattr(app_module, "backend_name", lambda: "file")

    with TestClient(app_module.app) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")


def test_misc_data_endpoints_return_patched_payloads_and_disable_caching(monkeypatch, misc_client: TestClient) -> None:
    eval_map = {"NVDA": {"overall_score": 9.1}}
    stocks_map = {"NVDA": {"indicators": {"price": 123.45}}}
    monkeypatch.setattr(misc_routes, "load_eval_map", lambda: eval_map)
    monkeypatch.setattr(misc_routes, "load_stocks", lambda: stocks_map)
    monkeypatch.setattr(misc_routes, "CONVEX_SYNC_ENABLED", True)
    monkeypatch.setattr(misc_routes, "CONVEX_URL", "https://example.convex.cloud")
    monkeypatch.setattr(misc_routes, "CONVEX_AUDIENCE", "stock-search")

    eval_response = misc_client.get(EVAL)
    stocks_response = misc_client.get(STOCKS)
    realtime_response = misc_client.get(REALTIME_CONFIG)
    standards_response = misc_client.get(COLOR_STANDARDS)

    eval_payload = eval_response.json()
    stocks_payload = stocks_response.json()

    assert eval_payload["NVDA"]["overall_score"] is not None
    assert stocks_payload["NVDA"]["indicators"]["price"] is not None
    assert_no_store(eval_response)
    assert_no_store(stocks_response)

    realtime_payload = realtime_response.json()
    assert realtime_payload["enabled"] is True
    assert realtime_payload["provider"]
    assert realtime_payload["convex_url"]
    assert realtime_payload["audience"]
    assert isinstance(realtime_payload["topics"], list)

    standards_payload = standards_response.json()
    assert "standards" in standards_payload
    assert "market_cap" in standards_payload["standards"]
    assert_no_store(standards_response)


async def _fake_news_fetch(ticker: str) -> list[NewsArticle]:
    return [
        NewsArticle(
            title=f"{ticker.upper()} headline",
            url=f"https://example.com/{ticker}-news-1",
            summary="Real fetched summary",
            relevancy="high",
            category="company_news",
            sentiment="bullish",
            metadata=NewsMetadata(provider="test"),
        )
    ]


def test_stock_news_endpoint_uses_live_pipeline(monkeypatch, misc_client: TestClient) -> None:
    monkeypatch.setattr(misc_routes, "get_news_async", _fake_news_fetch)

    response = misc_client.get(STOCK_NEWS.replace("{ticker}", "nvda"))

    assert response.status_code == 200
    assert_no_store(response)
    payload = response.json()
    assert len(payload) == 1
    for article in payload:
        assert set(article) >= NEWS_ARTICLE_FIELDS
        assert article["metadata"]["provider"] == "test"
        assert "nvda" in article["url"]


def test_evaluate_endpoint_returns_indicator_values_from_stock_indicator(monkeypatch, misc_client: TestClient) -> None:
    monkeypatch.setattr(misc_routes, "StockIndicator", FakeIndicator)

    response = misc_client.get(STOCK_EVALUATE.replace("{ticker}", "nvda"))

    assert response.status_code == 200
    payload = response.json()
    assert set(payload) >= EVALUATION_FIELDS
    assert payload["ticker"] == "NVDA"
    assert payload["price"] == 123.45
    assert payload["change_percent_1d"] == 1.5
    assert payload["rsi"] == 54.2
