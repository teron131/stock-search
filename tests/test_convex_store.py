from __future__ import annotations

from stock_search.models.convex import store as convex_store_module
from stock_search.models.convex.client import ConvexAPIError
from stock_search.models.convex.store import ConvexStore


class FakeConvexClient:
    def __init__(self) -> None:
        self.query_calls: list[tuple[str, dict | None]] = []
        self.mutation_calls: list[tuple[str, dict | None]] = []

    def query(self, path: str, args: dict | None = None):
        self.query_calls.append((path, args))
        if path == convex_store_module.CONVEX_STOCK_GET_MANY:
            raise ConvexAPIError(
                "Convex query failed for stock:getMany: Could not find function for 'stock:getMany'",
            )
        if path == convex_store_module.CONVEX_STOCK_GET:
            ticker = str(args.get("ticker") if isinstance(args, dict) else "").upper()
            return {
                "ticker": ticker,
                "indicators": {"price": 123.45},
                "evaluation": {},
                "labels": [],
            }
        raise AssertionError(f"Unexpected query: {path}")

    def mutation(self, path: str, args: dict | None = None):
        self.mutation_calls.append((path, args))
        if path == convex_store_module.CONVEX_STOCK_UPSERT_MANY:
            raise ConvexAPIError(
                "Convex mutation failed for stock:upsertMany: Could not find function for 'stock:upsertMany'",
            )
        if path == convex_store_module.CONVEX_STOCK_UPSERT:
            return {"ok": True}
        raise AssertionError(f"Unexpected mutation: {path}")


def build_store(fake_client: FakeConvexClient) -> ConvexStore:
    store = ConvexStore.__new__(ConvexStore)
    store._client = fake_client
    return store


def test_load_stocks_by_tickers_falls_back_to_single_get_calls_when_bulk_query_is_missing() -> None:
    fake_client = FakeConvexClient()
    store = build_store(fake_client)

    rows = store.load_stocks_by_tickers(["nvda", " msft "])

    assert rows == {
        "NVDA": {"indicators": {"price": 123.45}, "evaluation": {}, "labels": []},
        "MSFT": {"indicators": {"price": 123.45}, "evaluation": {}, "labels": []},
    }
    assert fake_client.query_calls == [
        (convex_store_module.CONVEX_STOCK_GET_MANY, {"tickers": ["NVDA", "MSFT"]}),
        (convex_store_module.CONVEX_STOCK_GET, {"ticker": "NVDA"}),
        (convex_store_module.CONVEX_STOCK_GET, {"ticker": "MSFT"}),
    ]


def test_upsert_stocks_falls_back_to_single_upserts_when_bulk_mutation_is_missing() -> None:
    fake_client = FakeConvexClient()
    store = build_store(fake_client)

    store.upsert_stocks(
        [
            {"ticker": "nvda", "indicators": {"price": 1}},
            {"ticker": "msft", "evaluation": {"overall_score": 9}},
        ]
    )

    assert fake_client.mutation_calls == [
        (
            convex_store_module.CONVEX_STOCK_UPSERT_MANY,
            {
                "rows": [
                    {"ticker": "nvda", "indicators": {"price": 1}},
                    {"ticker": "msft", "evaluation": {"overall_score": 9}},
                ]
            },
        ),
        (
            convex_store_module.CONVEX_STOCK_UPSERT,
            {"ticker": "nvda", "indicators": {"price": 1}},
        ),
        (
            convex_store_module.CONVEX_STOCK_UPSERT,
            {"ticker": "msft", "evaluation": {"overall_score": 9}},
        ),
    ]
