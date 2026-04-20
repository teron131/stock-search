from fastapi import FastAPI
from fastapi.testclient import TestClient

import stock_search.api.routes.portfolio as portfolio_routes
from stock_search.api.route_paths import PORTFOLIO


def _build_portfolio_app() -> FastAPI:
    api = FastAPI()
    api.include_router(portfolio_routes.router)
    return api


def test_portfolio_all_cached_scope_returns_cached_metadata(monkeypatch) -> None:
    calls: list[tuple[bool, bool]] = []

    async def fake_payload(*, include_cached_universe: bool, include_live_market: bool) -> dict:
        calls.append((include_cached_universe, include_live_market))
        return {
            "rows": [{"ticker": "NVDA", "quantity": 10}],
            "portfolio_stats": {},
            "meta": {},
        }

    monkeypatch.setattr(
        portfolio_routes,
        "get_portfolio_payload_async",
        fake_payload,
    )
    monkeypatch.setattr(
        portfolio_routes,
        "stats_cache_generated_at",
        lambda: "2026-04-18T00:00:00+00:00",
    )
    monkeypatch.setattr(
        portfolio_routes,
        "now_iso",
        lambda: "2026-04-18T01:00:00+00:00",
    )
    monkeypatch.setattr(portfolio_routes, "backend_name", lambda: "sqlite")

    with TestClient(_build_portfolio_app()) as client:
        response = client.get(f"{PORTFOLIO}?scope=all_cached")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, max-age=30, stale-while-revalidate=300"
    assert calls == [(True, False)]
    assert response.json()["meta"] == {
        "generated_at": "2026-04-18T00:00:00+00:00",
        "data_source": "cache",
        "backend_store": "sqlite",
        "sync_mode": "realtime_subscription",
    }


def test_portfolio_live_scope_disables_http_caching(monkeypatch) -> None:
    async def fake_payload(*, include_cached_universe: bool, include_live_market: bool) -> dict:
        assert include_cached_universe is False
        assert include_live_market is True
        return {
            "rows": [{"ticker": "NVDA", "quantity": 10}],
            "portfolio_stats": {},
            "meta": {},
        }

    monkeypatch.setattr(
        portfolio_routes,
        "get_portfolio_payload_async",
        fake_payload,
    )
    monkeypatch.setattr(
        portfolio_routes,
        "stats_cache_generated_at",
        lambda: "2026-04-18T00:00:00+00:00",
    )
    monkeypatch.setattr(
        portfolio_routes,
        "now_iso",
        lambda: "2026-04-18T01:00:00+00:00",
    )
    monkeypatch.setattr(portfolio_routes, "backend_name", lambda: "sqlite")

    with TestClient(_build_portfolio_app()) as client:
        response = client.get(f"{PORTFOLIO}?scope=portfolio_live")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
