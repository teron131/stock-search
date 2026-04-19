import asyncio

from stock_search.news.providers import exa


class _FakeResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {"results": []}


class _FakeClient:
    def __init__(self) -> None:
        self.last_json: dict | None = None

    async def post(self, *, url: str, json: dict, headers: dict) -> _FakeResponse:
        self.last_json = json
        return _FakeResponse()


def test_get_news_exa_async_caps_num_results_to_provider_limit() -> None:
    client = _FakeClient()

    asyncio.run(
        exa.get_news_exa_async(
            query="NVDA",
            max_results=99,
            client=client,
        )
    )

    assert client.last_json is not None
    assert client.last_json["num_results"] == exa.EXA_MAX_RESULTS_PER_CALL
