"""Persist the local portfolio cache in a SQLite database."""

from __future__ import annotations

import json
from pathlib import Path
import sqlite3
from typing import Any

from .utils import normalize_ticker_symbol


class SQLiteStore:
    """Read and write portfolio positions, stocks, and metadata in SQLite."""

    def __init__(
        self,
        db_path: str | Path,
    ) -> None:
        """Initialize the SQLite-backed store and ensure its schema exists."""
        self._db_path = Path(db_path)
        self._ensure_schema()

    @property
    def db_path(self) -> Path:
        """Return the SQLite database path."""
        return self._db_path

    def load_positions(self) -> list[dict[str, Any]]:
        """Load stored portfolio positions in their saved order."""
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json
                FROM positions
                ORDER BY sort_index ASC, ticker ASC
                """
            ).fetchall()

        positions: list[dict[str, Any]] = []
        for row in rows:
            payload = self._json_loads(row["payload_json"], default={})
            if isinstance(payload, dict):
                positions.append(payload)
        return positions

    def save_positions(self, positions: list[dict[str, Any]]) -> None:
        """Replace the stored portfolio positions."""
        normalized_positions: list[tuple[int, str, str]] = []
        for idx, position in enumerate(positions):
            if not isinstance(position, dict):
                continue
            ticker_symbol = normalize_ticker_symbol(str(position.get("ticker") or ""))
            if not ticker_symbol:
                continue
            payload = dict(position)
            payload["ticker"] = ticker_symbol
            normalized_positions.append((idx, ticker_symbol, self._json_dumps(payload)))

        with self._connect() as connection:
            connection.execute("DELETE FROM positions")
            connection.executemany(
                """
                INSERT INTO positions (ticker, sort_index, payload_json)
                VALUES (?, ?, ?)
                """,
                [(ticker, sort_index, payload_json) for sort_index, ticker, payload_json in normalized_positions],
            )
            connection.commit()

    def load_stocks(self) -> dict[str, dict[str, Any]]:
        """Load the merged stock map."""
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT ticker, indicators_json, evaluation_json, labels_json
                FROM stocks
                ORDER BY ticker ASC
                """
            ).fetchall()

        stocks: dict[str, dict[str, Any]] = {}
        for row in rows:
            ticker_symbol = normalize_ticker_symbol(row["ticker"])
            if not ticker_symbol:
                continue
            indicators = self._json_loads(row["indicators_json"], default={})
            evaluation = self._json_loads(row["evaluation_json"], default={})
            labels = self._json_loads(row["labels_json"], default=[])
            stocks[ticker_symbol] = {
                "indicators": dict(indicators) if isinstance(indicators, dict) else {},
                "evaluation": dict(evaluation) if isinstance(evaluation, dict) else {},
                "labels": list(labels) if isinstance(labels, list) else [],
            }
        return stocks

    def save_stocks(self, stocks_map: dict[str, dict[str, Any]]) -> None:
        """Replace the stored stock map."""
        normalized_rows: list[tuple[str, str, str, str]] = []
        for ticker, stock_row in stocks_map.items():
            if not isinstance(stock_row, dict):
                continue
            ticker_symbol = normalize_ticker_symbol(ticker)
            if not ticker_symbol:
                continue
            normalized_rows.append(
                (
                    ticker_symbol,
                    self._json_dumps(stock_row.get("indicators") if isinstance(stock_row.get("indicators"), dict) else {}),
                    self._json_dumps(stock_row.get("evaluation") if isinstance(stock_row.get("evaluation"), dict) else {}),
                    self._json_dumps(stock_row.get("labels") if isinstance(stock_row.get("labels"), list) else []),
                )
            )

        with self._connect() as connection:
            connection.execute("DELETE FROM stocks")
            connection.executemany(
                """
                INSERT INTO stocks (ticker, indicators_json, evaluation_json, labels_json)
                VALUES (?, ?, ?, ?)
                """,
                normalized_rows,
            )
            connection.commit()

    def get_meta_value(self, key: str) -> str | None:
        """Load one metadata value."""
        with self._connect() as connection:
            row = connection.execute(
                "SELECT value FROM meta WHERE key = ?",
                (key,),
            ).fetchone()
        if row is None:
            return None
        value = row["value"]
        return value if isinstance(value, str) else None

    def set_meta_value(self, *, key: str, value: str) -> None:
        """Save one metadata value."""
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO meta (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, value),
            )
            connection.commit()

    def _ensure_schema(self) -> None:
        """Create the SQLite schema when it does not already exist."""
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS positions (
                    ticker TEXT PRIMARY KEY,
                    sort_index INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS stocks (
                    ticker TEXT PRIMARY KEY,
                    indicators_json TEXT NOT NULL,
                    evaluation_json TEXT NOT NULL,
                    labels_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )
            connection.commit()

    def _connect(self) -> sqlite3.Connection:
        """Open a SQLite connection with row access enabled."""
        connection = sqlite3.connect(self._db_path, timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    @staticmethod
    def _json_dumps(value: Any) -> str:
        """Serialize a Python value to compact JSON."""
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _json_loads(payload: str, *, default: Any) -> Any:
        """Deserialize JSON text and fall back to the provided default."""
        try:
            return json.loads(payload)
        except (TypeError, json.JSONDecodeError):
            return default
