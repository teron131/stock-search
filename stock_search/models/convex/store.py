"""Persist portfolio, stock, and metadata records through Convex."""

from __future__ import annotations

from typing import Any

from .client import ConvexAPIError, ConvexHttpAdapter
from .convex_schemas import (
    normalize_portfolio_positions,
    normalize_stock_map,
    payload_to_stock_map,
    stock_map_to_rows,
)
from .function_names import (
    CONVEX_META_GET,
    CONVEX_META_SET,
    CONVEX_NEWS_LIST,
    CONVEX_NEWS_REPLACE_ALL,
    CONVEX_PORTFOLIO_GET,
    CONVEX_PORTFOLIO_SET,
    CONVEX_STOCK_GET,
    CONVEX_STOCK_GET_MANY,
    CONVEX_STOCK_LIST,
    CONVEX_STOCK_REPLACE_ALL,
    CONVEX_STOCK_UPSERT,
    CONVEX_STOCK_UPSERT_MANY,
)


class ConvexStore:
    """Typed storage facade for Convex table operations."""

    def __init__(self, *, base_url: str, deploy_key: str) -> None:
        """Initialize the Convex-backed repository wrapper."""
        self._client = ConvexHttpAdapter(
            base_url=base_url,
            deploy_key=deploy_key,
        )

    def load_stocks(self) -> dict[str, dict[str, Any]]:
        """Load the stock map from Convex."""
        payload = self._client.query(CONVEX_STOCK_LIST)
        return payload_to_stock_map(payload)

    @staticmethod
    def _is_missing_function_error(error: ConvexAPIError) -> bool:
        """Return whether Convex rejected a call because the function is undeployed."""
        return "Could not find function" in str(error)

    @staticmethod
    def _normalize_requested_tickers(tickers: list[str]) -> list[str]:
        """Normalize requested tickers while preserving order."""
        return [normalized_ticker for ticker in tickers if (normalized_ticker := str(ticker).strip().upper())]

    @staticmethod
    def _build_upsert_args(row: dict[str, Any]) -> dict[str, Any] | None:
        """Build one stock upsert payload from a partial row."""
        ticker = str(row.get("ticker") or "").strip()
        if not ticker:
            return None

        args: dict[str, Any] = {"ticker": ticker}
        if isinstance(row.get("indicators"), dict):
            args["indicators"] = row["indicators"]
        if isinstance(row.get("evaluation"), dict):
            args["evaluation"] = row["evaluation"]
        if isinstance(row.get("labels"), list):
            args["labels"] = row["labels"]
        return args

    def _load_stocks_one_by_one(
        self,
        tickers: list[str],
    ) -> dict[str, dict[str, Any]]:
        """Load stock rows with single-ticker queries."""
        rows = [self.load_stock(ticker_symbol) for ticker_symbol in tickers]
        return {ticker_symbol: row for ticker_symbol, row in zip(tickers, rows, strict=False) if isinstance(row, dict)}

    def _upsert_stocks_one_by_one(self, rows: list[dict[str, Any]]) -> None:
        """Upsert stock rows through the single-row mutation."""
        for row in rows:
            args = self._build_upsert_args(row)
            if args is None:
                continue
            self._client.mutation(CONVEX_STOCK_UPSERT, args)

    def load_stock(self, ticker: str) -> dict[str, Any] | None:
        """Load one stock row from Convex."""
        payload = self._client.query(CONVEX_STOCK_GET, {"ticker": ticker})
        if not isinstance(payload, dict):
            return None
        mapped = payload_to_stock_map([payload])
        return mapped.get(ticker.upper())

    def load_stocks_by_tickers(self, tickers: list[str]) -> dict[str, dict[str, Any]]:
        """Load multiple stock rows from Convex."""
        normalized_tickers = self._normalize_requested_tickers(tickers)
        if not normalized_tickers:
            return {}
        try:
            payload = self._client.query(
                CONVEX_STOCK_GET_MANY,
                {"tickers": normalized_tickers},
            )
        except ConvexAPIError as error:
            if not self._is_missing_function_error(error):
                raise
            return self._load_stocks_one_by_one(normalized_tickers)
        return payload_to_stock_map(payload)

    def save_stocks(self, stocks_map: dict[str, dict[str, Any]]) -> None:
        """Save stocks."""
        self._client.mutation(
            CONVEX_STOCK_REPLACE_ALL,
            {"rows": stock_map_to_rows(normalize_stock_map(stocks_map))},
        )

    def upsert_stock(
        self,
        *,
        ticker: str,
        indicators: dict[str, Any] | None = None,
        evaluation: dict[str, Any] | None = None,
        labels: list[str] | None = None,
    ) -> None:
        """Upsert one stock row while preserving omitted families."""
        args: dict[str, Any] = {"ticker": ticker}
        if indicators is not None:
            args["indicators"] = dict(indicators)
        if evaluation is not None:
            args["evaluation"] = dict(evaluation)
        if labels is not None:
            args["labels"] = list(labels)
        self._client.mutation(CONVEX_STOCK_UPSERT, args)

    def upsert_stocks(self, rows: list[dict[str, Any]]) -> None:
        """Upsert multiple stock rows while preserving omitted families."""
        normalized_rows = [dict(row) for row in rows if isinstance(row, dict)]
        if not normalized_rows:
            return
        try:
            self._client.mutation(CONVEX_STOCK_UPSERT_MANY, {"rows": normalized_rows})
        except ConvexAPIError as error:
            if not self._is_missing_function_error(error):
                raise
            self._upsert_stocks_one_by_one(normalized_rows)

    def load_portfolio(self, *, key: str = "default") -> dict[str, Any]:
        """Load the portfolio payload from Convex."""
        payload = self._client.query(
            CONVEX_PORTFOLIO_GET,
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
        """Save portfolio."""
        self._client.mutation(
            CONVEX_PORTFOLIO_SET,
            {
                "key": key,
                "positions": normalize_portfolio_positions(positions),
                "portfolioStats": dict(portfolio_stats) if isinstance(portfolio_stats, dict) else None,
            },
        )

    def load_news(self, *, key: str = "default") -> list[dict[str, Any]]:
        """Load the news feed from Convex."""
        payload = self._client.query(CONVEX_NEWS_LIST, {"key": key})
        return [dict(item) for item in payload if isinstance(item, dict)] if isinstance(payload, list) else []

    def save_news(self, rows: list[dict[str, Any]], *, key: str = "default") -> None:
        """Save news."""
        normalized_rows = [dict(row) for row in rows if isinstance(row, dict)]
        self._client.mutation(
            CONVEX_NEWS_REPLACE_ALL,
            {"key": key, "rows": normalized_rows},
        )

    def get_meta_value(self, key: str) -> str | None:
        """Return meta value."""
        payload = self._client.query(
            CONVEX_META_GET,
            {"key": key},
        )
        if not isinstance(payload, dict):
            return None
        value = payload.get("value")
        return value if isinstance(value, str) else None

    def set_meta_value(self, *, key: str, value: str) -> None:
        """Set meta value."""
        self._client.mutation(
            CONVEX_META_SET,
            {"key": key, "value": value},
        )
