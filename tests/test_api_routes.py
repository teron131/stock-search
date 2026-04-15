"""Route-level regression tests for stats data-source metadata."""

from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from stock_search.api.app import app


class ApiRoutesTestCase(unittest.TestCase):
    """Verify route metadata stays aligned with the resolver output."""

    def test_standalone_stats_route_preserves_source_metadata(self) -> None:
        source_expectations = {
            "cache": "cache",
            "auto": "live_with_cache_fallback",
            "live": "live",
        }

        for source, expected_data_source in source_expectations.items():
            with self.subTest(source=source):
                with (
                    patch("stock_search.api.app.backend_name", return_value="file"),
                    patch("stock_search.api.routes.standalone_ticker.backend_name", return_value="file"),
                    patch(
                        "stock_search.api.routes.standalone_ticker.resolve_standalone_ticker_stats",
                        new=AsyncMock(return_value=({"ticker": "AAPL", "price": 100.0}, expected_data_source)),
                    ),
                    TestClient(app) as client,
                ):
                    response = client.get(f"/stock/AAPL/stats?source={source}")

                assert response.status_code == 200
                payload = response.json()
                assert payload["row"]["ticker"] == "AAPL"
                assert payload["meta"]["data_source"] == expected_data_source

    def test_portfolio_route_uses_cache_for_priority_and_payload_meta_for_live_scopes(self) -> None:
        payload = {
            "rows": [],
            "tables": {},
            "portfolio_stats": {},
            "meta": {
                "generated_at": "stale-generated-at",
                "data_source": "live",
            },
        }
        expected = {
            "priority": ("cache", "2026-04-15T00:00:00+00:00"),
            "portfolio_live": ("live", "2026-04-15T01:00:00+00:00"),
            "all": ("live", "2026-04-15T01:00:00+00:00"),
        }

        for scope, (expected_data_source, expected_generated_at) in expected.items():
            with self.subTest(scope=scope):
                with (
                    patch("stock_search.api.app.backend_name", return_value="file"),
                    patch("stock_search.api.routes.portfolio.backend_name", return_value="file"),
                    patch("stock_search.api.routes.portfolio.stats_cache_generated_at", return_value="2026-04-15T00:00:00+00:00"),
                    patch("stock_search.api.routes.portfolio.now_iso", return_value="2026-04-15T01:00:00+00:00"),
                    patch(
                        "stock_search.api.routes.portfolio.get_portfolio_payload_async",
                        new=AsyncMock(return_value={**payload, "meta": dict(payload["meta"])}),
                    ),
                    TestClient(app) as client,
                ):
                    response = client.get(f"/portfolio?scope={scope}")

                assert response.status_code == 200
                body = response.json()
                assert body["meta"]["data_source"] == expected_data_source
                assert body["meta"]["generated_at"] == expected_generated_at


if __name__ == "__main__":
    unittest.main()
