import asyncio

from stock_search.news.providers import massive


class _FakeResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {"results": []}


class _FakeClient:
    def __init__(self) -> None:
        self.last_params: dict | None = None

    async def get(self, *, url: str, params: dict) -> _FakeResponse:
        self.last_params = params
        return _FakeResponse()


def test_get_news_massive_async_caps_limit_to_provider_max() -> None:
    client = _FakeClient()

    asyncio.run(
        massive.get_news_massive_async(
            ticker="NVDA",
            max_results=9999,
            client=client,
        )
    )

    assert client.last_params is not None
    assert client.last_params["limit"] == massive.MASSIVE_MAX_RESULTS
