"""Read and persist portfolio data through SQLite or Convex backends."""

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from functools import lru_cache
import logging
from typing import Any, Literal

import httpx

from stock_search.models.convex.client import ConvexAPIError
from stock_search.models.convex.store import ConvexStore
from stock_search.sqlite_store import SQLiteStore
from stock_search.utils import normalize_ticker_symbol

from .config import (
    CONVEX_DEPLOY_KEY,
    CONVEX_URL,
    DATA_SQLITE_PATH,
    DATA_STORE_BACKEND,
)

DataStoreBackend = Literal["convex", "sqlite"]

_CONVEX_READ_ERRORS = (httpx.HTTPError, ConvexAPIError)
logger = logging.getLogger(__name__)


def _normalize_backend(backend: str) -> DataStoreBackend:
    """Normalize the configured backend name."""
    normalized = backend.strip().lower()
    if normalized in {"convex", "sqlite"}:
        return normalized
    return "convex"


BACKEND: DataStoreBackend = _normalize_backend(DATA_STORE_BACKEND)


def _normalize_labels(value: Any) -> list[str]:
    """Normalize stored labels into a unique string list."""
    if not isinstance(value, list):
        return []
    labels: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        label = item.strip()
        if not label or label in seen:
            continue
        seen.add(label)
        labels.append(label)
    return labels


def _normalize_stocks_map(stocks_map: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Normalize a stock map into the canonical ticker-keyed shape."""
    normalized: dict[str, dict[str, Any]] = {}
    for ticker, stock_row in stocks_map.items():
        if not isinstance(stock_row, dict):
            continue
        ticker_symbol = normalize_ticker_symbol(ticker)
        if not ticker_symbol:
            continue
        normalized[ticker_symbol] = {
            "indicators": dict(stock_row.get("indicators") or {}),
            "evaluation": dict(stock_row.get("evaluation") or {}),
            "labels": list(stock_row.get("labels") or []),
        }
    return normalized


def _merge_stock_family(
    *,
    family_name: Literal["indicators", "evaluation"],
    payload: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Merge one stock family into the currently persisted stock map."""
    existing = load_stocks()
    merged = _normalize_stocks_map(existing)
    for ticker, row_payload in payload.items():
        if not isinstance(row_payload, dict):
            continue
        ticker_symbol = normalize_ticker_symbol(ticker)
        if not ticker_symbol:
            continue
        row = merged.setdefault(
            ticker_symbol,
            {"indicators": {}, "evaluation": {}, "labels": []},
        )
        row[family_name] = dict(row_payload)
    return merged


def backend_name() -> DataStoreBackend:
    """Return the configured data-store backend name."""
    return BACKEND


@lru_cache(maxsize=1)
def _convex_store() -> ConvexStore:
    """Return the cached Convex store client."""
    return ConvexStore(base_url=CONVEX_URL, deploy_key=CONVEX_DEPLOY_KEY)


@lru_cache(maxsize=1)
def _sqlite_store() -> SQLiteStore:
    """Return the cached SQLite store client."""
    return SQLiteStore(DATA_SQLITE_PATH)


def _load_positions_from_sqlite() -> list[dict[str, Any]]:
    """Load portfolio positions from the local SQLite store."""
    return _sqlite_store().load_positions()


def _load_stocks_from_sqlite() -> dict[str, dict[str, Any]]:
    """Load the merged stock map from the local SQLite store."""
    return _sqlite_store().load_stocks()


def _load_stats_map_from_sqlite() -> dict[str, dict[str, Any]]:
    """Load the indicator cache map from the local SQLite store."""
    stocks_map = _load_stocks_from_sqlite()
    return {ticker: dict(stock_row.get("indicators") or {}) for ticker, stock_row in stocks_map.items()}


def _load_eval_map_from_sqlite() -> dict[str, dict[str, Any]]:
    """Load the evaluation map from the local SQLite store."""
    stocks_map = _load_stocks_from_sqlite()
    return {ticker: dict(stock_row.get("evaluation") or {}) for ticker, stock_row in stocks_map.items()}


def _sqlite_stats_generated_at_iso() -> str | None:
    """Return the stored stats generation timestamp from SQLite."""
    return _sqlite_store().get_meta_value("stats_generated_at")


def _load_ticker_context_from_sqlite(ticker: str) -> tuple[list[dict[str, Any]], dict[str, Any], list[str]]:
    """Load positions plus one ticker's cached indicators and labels from SQLite."""
    positions = _load_positions_from_sqlite()
    stock_row = _load_stocks_from_sqlite().get(ticker)
    if not isinstance(stock_row, dict):
        return positions, {}, []

    indicators = dict(stock_row.get("indicators") or {})
    labels = _normalize_labels(stock_row.get("labels"))
    if not labels:
        labels = _normalize_labels(indicators.get("industry_labels") or indicators.get("labels"))
    return positions, indicators, labels


def _convex_read_or_local_fallback[T](operation: str, loader: Callable[[], T], fallback: Callable[[], T]) -> T:
    """Read from Convex and fall back to the local SQLite store on read errors."""
    try:
        return loader()
    except _CONVEX_READ_ERRORS:
        logger.warning(
            "Convex %s read failed, using SQLite fallback.",
            operation,
            exc_info=True,
        )
        return fallback()


def load_positions() -> list[dict[str, Any]]:
    """Load portfolio positions from the active data store."""
    if BACKEND == "convex":

        def _load_from_convex() -> list[dict[str, Any]]:
            portfolio = _convex_store().load_portfolio()
            positions = portfolio.get("positions")
            return [row for row in positions if isinstance(row, dict)] if isinstance(positions, list) else []

        return _convex_read_or_local_fallback(
            "positions",
            _load_from_convex,
            _load_positions_from_sqlite,
        )

    return _load_positions_from_sqlite()


def save_positions(positions: list[dict[str, Any]]) -> None:
    """Save portfolio positions to the active data store."""
    if BACKEND == "convex":
        existing = _convex_store().load_portfolio()
        portfolio_stats = existing.get("portfolio_stats")
        _convex_store().save_portfolio(
            positions=positions,
            portfolio_stats=portfolio_stats if isinstance(portfolio_stats, dict) else None,
        )
        return

    _sqlite_store().save_positions(positions)


def load_ticker_context(ticker: str) -> tuple[list[dict[str, Any]], dict[str, Any], list[str]]:
    """Load positions plus one ticker's cached indicators and labels."""
    ticker_symbol = normalize_ticker_symbol(ticker)
    if not ticker_symbol:
        return [], {}, []

    if BACKEND == "convex":

        def _load_from_convex() -> tuple[list[dict[str, Any]], dict[str, Any], list[str]]:
            store = _convex_store()
            with ThreadPoolExecutor(max_workers=2) as executor:
                portfolio_future = executor.submit(store.load_portfolio)
                stocks_future = executor.submit(store.load_stocks)
                portfolio = portfolio_future.result()
                stocks_map = stocks_future.result()

            positions = portfolio.get("positions")
            normalized_positions = [row for row in positions if isinstance(row, dict)] if isinstance(positions, list) else []
            stock_row = stocks_map.get(ticker_symbol)
            if not isinstance(stock_row, dict):
                return normalized_positions, {}, []

            indicators = dict(stock_row.get("indicators") or {})
            labels = _normalize_labels(stock_row.get("labels"))
            if not labels:
                labels = _normalize_labels(indicators.get("industry_labels") or indicators.get("labels"))
            return normalized_positions, indicators, labels

        return _convex_read_or_local_fallback(
            "ticker context",
            _load_from_convex,
            lambda: _load_ticker_context_from_sqlite(ticker_symbol),
        )

    return _load_ticker_context_from_sqlite(ticker_symbol)


def load_stocks() -> dict[str, dict[str, Any]]:
    """Load the stock map from the active data store."""
    if BACKEND == "convex":
        return _convex_read_or_local_fallback(
            "stocks",
            _convex_store().load_stocks,
            _load_stocks_from_sqlite,
        )

    return _load_stocks_from_sqlite()


def save_stocks(stocks_map: dict[str, dict[str, Any]]) -> None:
    """Save the merged stock map to the active data store."""
    normalized_stocks = _normalize_stocks_map(stocks_map)
    if BACKEND == "convex":
        _convex_store().save_stocks(normalized_stocks)
        set_stats_generated_at_iso()
        return

    _sqlite_store().save_stocks(normalized_stocks)
    set_stats_generated_at_iso()


def load_stats_map() -> dict[str, dict[str, Any]]:
    """Load the indicator cache map from the active data store."""
    if BACKEND == "convex":

        def _load_from_convex() -> dict[str, dict[str, Any]]:
            stocks_map = _convex_store().load_stocks()
            return {ticker: dict(stock_row.get("indicators") or {}) for ticker, stock_row in stocks_map.items()}

        return _convex_read_or_local_fallback(
            "stats",
            _load_from_convex,
            _load_stats_map_from_sqlite,
        )

    return _load_stats_map_from_sqlite()


def save_stats_map(stats_map: dict[str, dict[str, Any]]) -> None:
    """Save the indicator cache map to the active data store."""
    normalized = {ticker_symbol: dict(row) for ticker, row in stats_map.items() if isinstance(row, dict) and (ticker_symbol := normalize_ticker_symbol(ticker))}

    if BACKEND == "convex":
        merged = _merge_stock_family(family_name="indicators", payload=normalized)
        _convex_store().save_stocks(merged)
        set_stats_generated_at_iso()
        return

    merged = _merge_stock_family(family_name="indicators", payload=normalized)
    _sqlite_store().save_stocks(merged)
    set_stats_generated_at_iso()


def load_eval_map() -> dict[str, dict[str, Any]]:
    """Load the evaluation map from the active data store."""
    if BACKEND == "convex":

        def _load_from_convex() -> dict[str, dict[str, Any]]:
            stocks_map = _convex_store().load_stocks()
            return {ticker: dict(stock_row.get("evaluation") or {}) for ticker, stock_row in stocks_map.items()}

        return _convex_read_or_local_fallback(
            "eval",
            _load_from_convex,
            _load_eval_map_from_sqlite,
        )

    return _load_eval_map_from_sqlite()


def save_eval_map(eval_map: dict[str, dict[str, Any]]) -> None:
    """Save the evaluation map to the active data store."""
    normalized = {ticker_symbol: dict(row) for ticker, row in eval_map.items() if isinstance(row, dict) and (ticker_symbol := normalize_ticker_symbol(ticker))}

    if BACKEND == "convex":
        merged = _merge_stock_family(family_name="evaluation", payload=normalized)
        _convex_store().save_stocks(merged)
        return

    merged = _merge_stock_family(family_name="evaluation", payload=normalized)
    _sqlite_store().save_stocks(merged)


def stats_generated_at_iso() -> str | None:
    """Return the current stats generation timestamp in ISO format."""
    if BACKEND == "convex":
        return _convex_read_or_local_fallback(
            "meta stats_generated_at",
            lambda: _convex_store().get_meta_value("stats_generated_at"),
            _sqlite_stats_generated_at_iso,
        )

    return _sqlite_stats_generated_at_iso()


def set_stats_generated_at_iso(timestamp: str | None = None) -> None:
    """Persist the current stats generation timestamp in the active data store."""
    resolved = timestamp or datetime.now(tz=UTC).isoformat()
    if BACKEND == "convex":
        _convex_store().set_meta_value(key="stats_generated_at", value=resolved)
        return

    _sqlite_store().set_meta_value(key="stats_generated_at", value=resolved)
