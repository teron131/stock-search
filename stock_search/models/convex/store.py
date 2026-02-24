from __future__ import annotations

from typing import Any

from .client import ConvexHttpAdapter
from .schemas import (
    normalize_positions_for_convex,
    normalize_ticker_map,
    payload_to_ticker_map,
    ticker_map_to_rows,
)


class ConvexStore:
    """Typed storage facade for Convex table operations."""

    def __init__(self, *, base_url: str, deploy_key: str) -> None:
        self._client = ConvexHttpAdapter(base_url=base_url, deploy_key=deploy_key)

    def load_positions(self) -> list[dict[str, Any]]:
        payload = self._client.query("positions:list")
        return normalize_positions_for_convex(payload if isinstance(payload, list) else [])

    def save_positions(self, positions: list[dict[str, Any]]) -> None:
        self._client.mutation("positions:replaceAll", {"positions": normalize_positions_for_convex(positions)})

    def load_stats_map(self) -> dict[str, dict[str, Any]]:
        payload = self._client.query("stats:list")
        return payload_to_ticker_map(payload)

    def save_stats_map(self, stats_map: dict[str, dict[str, Any]]) -> None:
        self._client.mutation("stats:replaceAll", {"rows": ticker_map_to_rows(normalize_ticker_map(stats_map))})

    def load_eval_map(self) -> dict[str, dict[str, Any]]:
        payload = self._client.query("evals:list")
        return payload_to_ticker_map(payload)

    def save_eval_map(self, eval_map: dict[str, dict[str, Any]]) -> None:
        self._client.mutation("evals:replaceAll", {"rows": ticker_map_to_rows(normalize_ticker_map(eval_map))})

    def get_meta_value(self, key: str) -> str | None:
        payload = self._client.query("meta_versions:get", {"key": key})
        if not isinstance(payload, dict):
            return None
        value = payload.get("value")
        return value if isinstance(value, str) else None

    def set_meta_value(self, *, key: str, value: str) -> None:
        self._client.mutation("meta_versions:set", {"key": key, "value": value})
