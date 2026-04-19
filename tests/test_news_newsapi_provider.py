import asyncio

from stock_search.news.providers import newsapi


class _FakeResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {"articles": []}


class _FakeClient:
    def __init__(self) -> None:
        self.last_params: dict | None = None

    async def get(self, *, url: str, params: dict) -> _FakeResponse:
        self.last_params = params
        return _FakeResponse()


def test_get_news_newsapi_async_caps_page_size_to_provider_limit() -> None:
    client = _FakeClient()

    asyncio.run(
        newsapi.get_news_newsapi_async(
            query="NVDA",
            max_results=999,
            client=client,
        )
    )

    assert client.last_params is not None
    assert client.last_params["pageSize"] == newsapi.NEWSAPI_MAX_RESULTS
