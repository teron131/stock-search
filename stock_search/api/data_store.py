from __future__ import annotations

from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, Literal

from stock_search.file_utils import load_json, write_json
from stock_search.models.convex.store import ConvexStore
from stock_search.utils import normalize_ticker_symbol

from .config import CONVEX_DEPLOY_KEY, CONVEX_URL, DATA_STORE_BACKEND, EVAL_PATH, PORTFOLIO_PATH, STATS_PATH

DataStoreBackend = Literal["convex", "file"]


def _normalize_backend(backend: str) -> DataStoreBackend:
    normalized = backend.strip().lower()
    if normalized in {"convex", "file"}:
        return normalized
    return "convex"


BACKEND: DataStoreBackend = _normalize_backend(DATA_STORE_BACKEND)


def backend_name() -> DataStoreBackend:
    return BACKEND


@lru_cache(maxsize=1)
def _convex_store() -> ConvexStore:
    return ConvexStore(base_url=CONVEX_URL, deploy_key=CONVEX_DEPLOY_KEY)


def load_positions() -> list[dict[str, Any]]:
    if BACKEND == "convex":
        return _convex_store().load_positions()

    portfolio_data = load_json(PORTFOLIO_PATH, default=[])
    if isinstance(portfolio_data, list):
        return [row for row in portfolio_data if isinstance(row, dict)]
    if isinstance(portfolio_data, dict):
        positions = portfolio_data.get("positions", [])
        return [row for row in positions if isinstance(row, dict)] if isinstance(positions, list) else []
    return []


def save_positions(positions: list[dict[str, Any]]) -> None:
    if BACKEND == "convex":
        _convex_store().save_positions(positions)
        return
    write_json(PORTFOLIO_PATH, {"positions": positions})


def load_stats_map() -> dict[str, dict[str, Any]]:
    if BACKEND == "convex":
        return _convex_store().load_stats_map()
    stats_data = load_json(STATS_PATH, default={})
    if not isinstance(stats_data, dict):
        return {}
    return {ticker_symbol: dict(row) for ticker, row in stats_data.items() if isinstance(row, dict) and (ticker_symbol := normalize_ticker_symbol(ticker))}


def save_stats_map(stats_map: dict[str, dict[str, Any]]) -> None:
    normalized = {ticker_symbol: dict(row) for ticker, row in stats_map.items() if isinstance(row, dict) and (ticker_symbol := normalize_ticker_symbol(ticker))}

    if BACKEND == "convex":
        _convex_store().save_stats_map(normalized)
        set_stats_generated_at_iso()
        return
    write_json(STATS_PATH, normalized)


def load_eval_map() -> dict[str, dict[str, Any]]:
    if BACKEND == "convex":
        return _convex_store().load_eval_map()

    eval_data_raw = load_json(EVAL_PATH, default={})
    if isinstance(eval_data_raw, dict):
        return {ticker_symbol: dict(row) for ticker, row in eval_data_raw.items() if isinstance(row, dict) and (ticker_symbol := normalize_ticker_symbol(ticker))}

    if not isinstance(eval_data_raw, list):
        return {}

    return {ticker: item for item in eval_data_raw if isinstance(item, dict) and (ticker := normalize_ticker_symbol(str(item.get("ticker") or "")))}


def save_eval_map(eval_map: dict[str, dict[str, Any]]) -> None:
    normalized = {ticker_symbol: dict(row) for ticker, row in eval_map.items() if isinstance(row, dict) and (ticker_symbol := normalize_ticker_symbol(ticker))}

    if BACKEND == "convex":
        _convex_store().save_eval_map(normalized)
        return
    write_json(EVAL_PATH, normalized)


def stats_generated_at_iso() -> str | None:
    if BACKEND == "convex":
        return _convex_store().get_meta_value("stats_generated_at")

    if not STATS_PATH.exists():
        return None
    modified_at = datetime.fromtimestamp(STATS_PATH.stat().st_mtime, tz=UTC)
    return modified_at.isoformat()


def set_stats_generated_at_iso(timestamp: str | None = None) -> None:
    if BACKEND != "convex":
        return
    resolved = timestamp or datetime.now(tz=UTC).isoformat()
    _convex_store().set_meta_value(key="stats_generated_at", value=resolved)
