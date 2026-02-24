from __future__ import annotations

from typing import Any

from .client import ConvexHttpAdapter
from .convex_schemas import (
    normalize_portfolio_positions,
    normalize_stock_map,
    payload_to_stock_map,
    stock_map_to_rows,
)


class ConvexStore:
    """Typed storage facade for Convex table operations."""

    def __init__(self, *, base_url: str, deploy_key: str) -> None:
        self._client = ConvexHttpAdapter(
            base_url=base_url,
            deploy_key=deploy_key,
        )

    def load_stocks(self) -> dict[str, dict[str, Any]]:
        payload = self._client.query("stocks:list")
        return payload_to_stock_map(payload)

    def save_stocks(self, stocks_map: dict[str, dict[str, Any]]) -> None:
        self._client.mutation(
            "stocks:replaceAll",
            {"rows": stock_map_to_rows(normalize_stock_map(stocks_map))},
        )

    def load_portfolio(self, *, key: str = "default") -> dict[str, Any]:
        payload = self._client.query(
            "portfolios:get",
            {"key": key},
        )
        if not isinstance(payload, dict):
            return {
                "positions": [],
                "portfolio_stats": None,
            }
        positions = payload.get("positions")
        portfolio_stats = payload.get("portfolioStats")
        return {
            "positions": normalize_portfolio_positions(positions if isinstance(positions, list) else []),
            "portfolio_stats": dict(portfolio_stats) if isinstance(portfolio_stats, dict) else None,
        }

    def save_portfolio(
        self,
        *,
        positions: list[dict[str, Any]],
        portfolio_stats: dict[str, Any] | None = None,
        key: str = "default",
    ) -> None:
        self._client.mutation(
            "portfolios:set",
            {
                "key": key,
                "positions": normalize_portfolio_positions(positions),
                "portfolioStats": dict(portfolio_stats) if isinstance(portfolio_stats, dict) else None,
            },
        )

    def load_news(self, *, key: str = "default") -> list[dict[str, Any]]:
        payload = self._client.query("news:list", {"key": key})
        return [dict(item) for item in payload if isinstance(item, dict)] if isinstance(payload, list) else []

    def save_news(self, rows: list[dict[str, Any]], *, key: str = "default") -> None:
        normalized_rows = [dict(row) for row in rows if isinstance(row, dict)]
        self._client.mutation(
            "news:replaceAll",
            {"key": key, "rows": normalized_rows},
        )

    def get_meta_value(self, key: str) -> str | None:
        payload = self._client.query(
            "meta_versions:get",
            {"key": key},
        )
        if not isinstance(payload, dict):
            return None
        value = payload.get("value")
        return value if isinstance(value, str) else None

    def set_meta_value(self, *, key: str, value: str) -> None:
        self._client.mutation(
            "meta_versions:set",
            {"key": key, "value": value},
        )
