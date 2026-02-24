from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from stock_search.utils import normalize_ticker_symbol


class ConvexPositionRow(BaseModel):
    ticker: str
    quantity: float
    strategy: str | None = None
    labels: list[str] = Field(default_factory=list)
    updatedAt: int | None = None


class ConvexStatsRow(BaseModel):
    ticker: str
    row: dict[str, Any] = Field(default_factory=dict)
    source: str | None = None
    generatedAt: int | None = None
    fundamentalsFetchedAt: int | None = None
    updatedAt: int | None = None


class ConvexEvalRow(BaseModel):
    ticker: str
    row: dict[str, Any] = Field(default_factory=dict)
    updatedAt: int | None = None


class ConvexMetaVersionRow(BaseModel):
    key: str
    value: str
    updatedAt: int | None = None


def normalize_positions_for_convex(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        ticker = normalize_ticker_symbol(str(row.get("ticker") or ""))
        if not ticker:
            continue
        payload: dict[str, Any] = {
            "ticker": ticker,
            "quantity": float(row.get("quantity") or 0.0),
        }
        strategy = row.get("strategy")
        if isinstance(strategy, str) and strategy.strip():
            payload["strategy"] = strategy
        labels = row.get("labels")
        if isinstance(labels, list):
            payload["labels"] = [str(label).strip() for label in labels if str(label).strip()]
        normalized.append(ConvexPositionRow.model_validate(payload).model_dump(exclude_none=True))
    return normalized


def normalize_ticker_map(rows: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    normalized: dict[str, dict[str, Any]] = {}
    for ticker, row in rows.items():
        if not isinstance(row, dict):
            continue
        ticker_symbol = normalize_ticker_symbol(ticker)
        if not ticker_symbol:
            continue
        normalized[ticker_symbol] = dict(row)
    return normalized


def payload_to_ticker_map(items: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(items, list):
        return {}
    mapped: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        ticker = normalize_ticker_symbol(str(item.get("ticker") or ""))
        if not ticker:
            continue
        mapped[ticker] = {k: v for k, v in item.items() if k != "ticker"}
    return mapped


def ticker_map_to_rows(rows: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"ticker": ticker, **row} for ticker, row in normalize_ticker_map(rows).items()]
