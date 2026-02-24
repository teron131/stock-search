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
        self._client = ConvexHttpAdapter(base_url=base_url, deploy_key=deploy_key)

    def load_stocks(self) -> dict[str, dict[str, Any]]:
        payload = self._client.query("stocks:list")
        return payload_to_stock_map(payload)

    def save_stocks(self, stocks_map: dict[str, dict[str, Any]]) -> None:
        self._client.mutation("stocks:replaceAll", {"rows": stock_map_to_rows(normalize_stock_map(stocks_map))})

    def load_portfolio(self, *, key: str = "default") -> dict[str, Any]:
        payload = self._client.query("portfolios:get", {"key": key})
        if not isinstance(payload, dict):
            return {"positions": [], "portfolio_stats": None}
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
        self._client.mutation("news:replaceAll", {"key": key, "rows": normalized_rows})

    # Transitional adapters used by current API surface.
    def load_positions(self) -> list[dict[str, Any]]:
        return self.load_portfolio().get("positions", [])

    def save_positions(self, positions: list[dict[str, Any]]) -> None:
        existing = self.load_portfolio()
        self.save_portfolio(
            positions=positions,
            portfolio_stats=existing.get("portfolio_stats"),
        )

    def load_stats_map(self) -> dict[str, dict[str, Any]]:
        stocks_map = self.load_stocks()
        return {ticker: dict(stock_row.get("indicators") or {}) for ticker, stock_row in stocks_map.items()}

    def save_stats_map(self, stats_map: dict[str, dict[str, Any]]) -> None:
        existing = self.load_stocks()
        merged = {
            ticker: {
                "indicators": dict(stock_row.get("indicators") or {}),
                "evaluation": dict(stock_row.get("evaluation") or {}),
                "labels": list(stock_row.get("labels") or []),
            }
            for ticker, stock_row in existing.items()
        }
        for ticker, stats_row in stats_map.items():
            if not isinstance(stats_row, dict):
                continue
            ticker_key = ticker.upper().strip()
            if not ticker_key:
                continue
            row = merged.setdefault(ticker_key, {"indicators": {}, "evaluation": {}, "labels": []})
            row["indicators"] = dict(stats_row)
        self.save_stocks(merged)

    def load_eval_map(self) -> dict[str, dict[str, Any]]:
        stocks_map = self.load_stocks()
        return {ticker: dict(stock_row.get("evaluation") or {}) for ticker, stock_row in stocks_map.items()}

    def save_eval_map(self, eval_map: dict[str, dict[str, Any]]) -> None:
        existing = self.load_stocks()
        merged = {
            ticker: {
                "indicators": dict(stock_row.get("indicators") or {}),
                "evaluation": dict(stock_row.get("evaluation") or {}),
                "labels": list(stock_row.get("labels") or []),
            }
            for ticker, stock_row in existing.items()
        }
        for ticker, eval_row in eval_map.items():
            if not isinstance(eval_row, dict):
                continue
            ticker_key = ticker.upper().strip()
            if not ticker_key:
                continue
            row = merged.setdefault(ticker_key, {"indicators": {}, "evaluation": {}, "labels": []})
            row["evaluation"] = dict(eval_row)
        self.save_stocks(merged)

    def get_meta_value(self, key: str) -> str | None:
        payload = self._client.query("meta_versions:get", {"key": key})
        if not isinstance(payload, dict):
            return None
        value = payload.get("value")
        return value if isinstance(value, str) else None

    def set_meta_value(self, *, key: str, value: str) -> None:
        self._client.mutation("meta_versions:set", {"key": key, "value": value})
