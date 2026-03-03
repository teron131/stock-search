from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from functools import lru_cache
import logging
from typing import Any, Literal, TypeVar

import httpx

from stock_search.file_utils import load_json, write_json
from stock_search.models.convex.client import ConvexAPIError
from stock_search.models.convex.store import ConvexStore
from stock_search.utils import normalize_ticker_symbol

from .config import CONVEX_DEPLOY_KEY, CONVEX_URL, DATA_STORE_BACKEND, EVAL_PATH, PORTFOLIO_PATH, STATS_PATH

DataStoreBackend = Literal["convex", "file"]
T = TypeVar("T")

_CONVEX_READ_ERRORS = (httpx.HTTPError, ConvexAPIError)
logger = logging.getLogger(__name__)


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


def _load_positions_from_file() -> list[dict[str, Any]]:
    portfolio_data = load_json(PORTFOLIO_PATH, default=[])
    if isinstance(portfolio_data, list):
        return [row for row in portfolio_data if isinstance(row, dict)]
    if isinstance(portfolio_data, dict):
        positions = portfolio_data.get("positions", [])
        return [row for row in positions if isinstance(row, dict)] if isinstance(positions, list) else []
    return []


def _load_stats_map_from_file() -> dict[str, dict[str, Any]]:
    stats_data = load_json(STATS_PATH, default={})
    if not isinstance(stats_data, dict):
        return {}
    return {ticker_symbol: dict(row) for ticker, row in stats_data.items() if isinstance(row, dict) and (ticker_symbol := normalize_ticker_symbol(ticker))}


def _load_eval_map_from_file() -> dict[str, dict[str, Any]]:
    eval_data_raw = load_json(EVAL_PATH, default={})
    if isinstance(eval_data_raw, dict):
        return {ticker_symbol: dict(row) for ticker, row in eval_data_raw.items() if isinstance(row, dict) and (ticker_symbol := normalize_ticker_symbol(ticker))}

    if not isinstance(eval_data_raw, list):
        return {}

    return {ticker: item for item in eval_data_raw if isinstance(item, dict) and (ticker := normalize_ticker_symbol(str(item.get("ticker") or "")))}


def _build_stocks_from_maps(
    stats_map: dict[str, dict[str, Any]],
    eval_map: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    tickers = sorted(set(stats_map) | set(eval_map))
    stocks: dict[str, dict[str, Any]] = {}
    for ticker in tickers:
        stocks[ticker] = {
            "indicators": dict(stats_map.get(ticker) or {}),
            "evaluation": dict(eval_map.get(ticker) or {}),
            "labels": [],
        }
    return stocks


def _load_stocks_from_file() -> dict[str, dict[str, Any]]:
    return _build_stocks_from_maps(
        _load_stats_map_from_file(),
        _load_eval_map_from_file(),
    )


def _file_stats_generated_at_iso() -> str | None:
    if not STATS_PATH.exists():
        return None
    modified_at = datetime.fromtimestamp(STATS_PATH.stat().st_mtime, tz=UTC)
    return modified_at.isoformat()


def _convex_read_or_file_fallback(operation: str, loader: Callable[[], T], fallback: Callable[[], T]) -> T:
    try:
        return loader()
    except _CONVEX_READ_ERRORS:
        logger.warning(
            "Convex %s read failed, using fallback path.",
            operation,
            exc_info=True,
        )
        return fallback()


def load_positions() -> list[dict[str, Any]]:
    if BACKEND == "convex":

        def _load_from_convex() -> list[dict[str, Any]]:
            portfolio = _convex_store().load_portfolio()
            positions = portfolio.get("positions")
            return [row for row in positions if isinstance(row, dict)] if isinstance(positions, list) else []

        return _convex_read_or_file_fallback(
            "positions",
            _load_from_convex,
            _load_positions_from_file,
        )

    return _load_positions_from_file()


def save_positions(positions: list[dict[str, Any]]) -> None:
    if BACKEND == "convex":
        existing = _convex_store().load_portfolio()
        portfolio_stats = existing.get("portfolio_stats")
        _convex_store().save_portfolio(
            positions=positions,
            portfolio_stats=portfolio_stats if isinstance(portfolio_stats, dict) else None,
        )
        return
    write_json(PORTFOLIO_PATH, {"positions": positions})


def load_stocks() -> dict[str, dict[str, Any]]:
    if BACKEND == "convex":
        return _convex_read_or_file_fallback(
            "stocks",
            _convex_store().load_stocks,
            dict,
        )

    return _load_stocks_from_file()


def save_stocks(stocks_map: dict[str, dict[str, Any]]) -> None:
    normalized_stocks = {ticker_symbol: dict(row) for ticker, row in stocks_map.items() if isinstance(row, dict) and (ticker_symbol := normalize_ticker_symbol(ticker))}
    if BACKEND == "convex":
        _convex_store().save_stocks(normalized_stocks)
        set_stats_generated_at_iso()
        return

    stats_map = {ticker: dict(stock_row.get("indicators") or {}) for ticker, stock_row in normalized_stocks.items()}
    eval_map = {ticker: dict(stock_row.get("evaluation") or {}) for ticker, stock_row in normalized_stocks.items()}
    write_json(STATS_PATH, stats_map)
    write_json(EVAL_PATH, eval_map)


def load_stats_map() -> dict[str, dict[str, Any]]:
    if BACKEND == "convex":

        def _load_from_convex() -> dict[str, dict[str, Any]]:
            stocks_map = _convex_store().load_stocks()
            return {ticker: dict(stock_row.get("indicators") or {}) for ticker, stock_row in stocks_map.items()}

        return _convex_read_or_file_fallback(
            "stats",
            _load_from_convex,
            dict,
        )

    return _load_stats_map_from_file()


def save_stats_map(stats_map: dict[str, dict[str, Any]]) -> None:
    normalized = {ticker_symbol: dict(row) for ticker, row in stats_map.items() if isinstance(row, dict) and (ticker_symbol := normalize_ticker_symbol(ticker))}

    if BACKEND == "convex":
        existing = _convex_store().load_stocks()
        merged: dict[str, dict[str, Any]] = {
            ticker: {
                "indicators": dict(stock_row.get("indicators") or {}),
                "evaluation": dict(stock_row.get("evaluation") or {}),
                "labels": list(stock_row.get("labels") or []),
            }
            for ticker, stock_row in existing.items()
        }
        for ticker, stats_row in normalized.items():
            row = merged.setdefault(
                ticker,
                {"indicators": {}, "evaluation": {}, "labels": []},
            )
            row["indicators"] = dict(stats_row)
        _convex_store().save_stocks(merged)
        set_stats_generated_at_iso()
        return
    write_json(STATS_PATH, normalized)


def load_eval_map() -> dict[str, dict[str, Any]]:
    if BACKEND == "convex":

        def _load_from_convex() -> dict[str, dict[str, Any]]:
            stocks_map = _convex_store().load_stocks()
            return {ticker: dict(stock_row.get("evaluation") or {}) for ticker, stock_row in stocks_map.items()}

        return _convex_read_or_file_fallback(
            "eval",
            _load_from_convex,
            dict,
        )

    return _load_eval_map_from_file()


def save_eval_map(eval_map: dict[str, dict[str, Any]]) -> None:
    normalized = {ticker_symbol: dict(row) for ticker, row in eval_map.items() if isinstance(row, dict) and (ticker_symbol := normalize_ticker_symbol(ticker))}

    if BACKEND == "convex":
        existing = _convex_store().load_stocks()
        merged: dict[str, dict[str, Any]] = {
            ticker: {
                "indicators": dict(stock_row.get("indicators") or {}),
                "evaluation": dict(stock_row.get("evaluation") or {}),
                "labels": list(stock_row.get("labels") or []),
            }
            for ticker, stock_row in existing.items()
        }
        for ticker, eval_row in normalized.items():
            row = merged.setdefault(
                ticker,
                {"indicators": {}, "evaluation": {}, "labels": []},
            )
            row["evaluation"] = dict(eval_row)
        _convex_store().save_stocks(merged)
        return
    write_json(EVAL_PATH, normalized)


def stats_generated_at_iso() -> str | None:
    if BACKEND == "convex":
        return _convex_read_or_file_fallback(
            "meta stats_generated_at",
            lambda: _convex_store().get_meta_value("stats_generated_at"),
            lambda: None,
        )

    return _file_stats_generated_at_iso()


def set_stats_generated_at_iso(timestamp: str | None = None) -> None:
    if BACKEND != "convex":
        return
    resolved = timestamp or datetime.now(tz=UTC).isoformat()
    _convex_store().set_meta_value(key="stats_generated_at", value=resolved)
