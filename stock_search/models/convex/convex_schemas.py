"""Normalize Convex rows to and from local stock models."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from stock_search.utils import normalize_ticker_symbol


class ConvexStockRow(BaseModel):
    """Represent one Convex stock row."""

    ticker: str
    indicators: dict[str, Any] = Field(default_factory=dict)
    evaluation: dict[str, Any] = Field(default_factory=dict)
    labels: list[str] = Field(default_factory=list)
    updatedAt: int | None = None


class ConvexPortfolioPosition(BaseModel):
    """Represent Convex portfolio position."""

    ticker: str
    quantity: float


class ConvexPortfolioRow(BaseModel):
    """Represent one Convex portfolio row."""

    key: str = "default"
    positions: list[ConvexPortfolioPosition] = Field(default_factory=list)
    portfolioStats: dict[str, Any] | None = None
    updatedAt: int | None = None


class ConvexNewsRow(BaseModel):
    """Represent one Convex news row."""

    key: str = "default"
    ticker: str
    row: dict[str, Any] = Field(default_factory=dict)
    updatedAt: int | None = None


class ConvexMetaVersionRow(BaseModel):
    """Represent one Convex meta version row."""

    key: str
    value: str
    updatedAt: int | None = None


def normalize_portfolio_positions(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize Convex portfolio rows into local position dicts."""
    normalized: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        ticker = normalize_ticker_symbol(str(row.get("ticker") or ""))
        if not ticker:
            continue
        payload = ConvexPortfolioPosition(
            ticker=ticker,
            quantity=float(row.get("quantity") or 0.0),
        )
        normalized.append(payload.model_dump(exclude_none=True))
    return normalized


def normalize_stock_map(rows: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Normalize Convex stock rows into the local stock map."""
    normalized: dict[str, dict[str, Any]] = {}
    for ticker, row in rows.items():
        if not isinstance(row, dict):
            continue
        ticker_symbol = normalize_ticker_symbol(ticker)
        if not ticker_symbol:
            continue
        indicators = row.get("indicators")
        evaluation = row.get("evaluation")
        labels = row.get("labels")
        normalized[ticker_symbol] = ConvexStockRow(
            ticker=ticker_symbol,
            indicators=dict(indicators) if isinstance(indicators, dict) else {},
            evaluation=dict(evaluation) if isinstance(evaluation, dict) else {},
            labels=[str(label).strip() for label in labels if str(label).strip()] if isinstance(labels, list) else [],
        ).model_dump(exclude_none=True)
    return normalized


def payload_to_stock_map(items: Any) -> dict[str, dict[str, Any]]:
    """Convert a Convex payload into the local stock map shape."""
    if not isinstance(items, list):
        return {}
    mapped: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        ticker = normalize_ticker_symbol(str(item.get("ticker") or ""))
        if not ticker:
            continue
        indicators = item.get("indicators")
        evaluation = item.get("evaluation")
        labels = item.get("labels")
        mapped[ticker] = {
            "indicators": dict(indicators) if isinstance(indicators, dict) else {},
            "evaluation": dict(evaluation) if isinstance(evaluation, dict) else {},
            "labels": [str(label).strip() for label in labels if str(label).strip()] if isinstance(labels, list) else [],
        }
    return mapped


def stock_map_to_rows(rows: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert the local stock map into Convex row payloads."""
    return [
        {
            "ticker": ticker,
            **row,
        }
        for ticker, row in normalize_stock_map(rows).items()
    ]
