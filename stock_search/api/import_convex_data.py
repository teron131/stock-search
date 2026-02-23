from __future__ import annotations

from datetime import UTC, datetime
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from stock_search.file_utils import load_json
from stock_search.utils import normalize_ticker_symbol

from .config import EVAL_PATH, PORTFOLIO_PATH, STATS_PATH
from .convex_client import ConvexHttpAdapter

STATS_GENERATED_AT_KEY = "stats_generated_at"


def _load_positions(path: Path) -> list[dict[str, Any]]:
    payload = load_json(path, default=[])
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        positions = payload.get("positions", [])
        if isinstance(positions, list):
            return [row for row in positions if isinstance(row, dict)]
    return []


def _normalize_positions_for_convex(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for row in rows:
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
        normalized.append(payload)
    return normalized


def _load_ticker_map(path: Path) -> dict[str, dict[str, Any]]:
    payload = load_json(path, default={})
    if not isinstance(payload, dict):
        return {}
    return {
        ticker_symbol: row
        for ticker, row in payload.items()
        if isinstance(row, dict) and (ticker_symbol := normalize_ticker_symbol(ticker))
    }


def run_import_from_local_files(
    *,
    portfolio_path: Path = PORTFOLIO_PATH,
    stats_path: Path = STATS_PATH,
    eval_path: Path = EVAL_PATH,
) -> dict[str, int]:
    client = ConvexHttpAdapter(base_url=os.getenv("CONVEX_URL", ""), deploy_key=os.getenv("CONVEX_DEPLOY_KEY", ""))
    positions = _normalize_positions_for_convex(_load_positions(portfolio_path))
    stats_map = _load_ticker_map(stats_path)
    eval_map = _load_ticker_map(eval_path)

    client.mutation("positions:replaceAll", {"positions": positions})
    client.mutation("stats:replaceAll", {"rows": [{"ticker": ticker, **row} for ticker, row in stats_map.items()]})
    client.mutation("evals:replaceAll", {"rows": [{"ticker": ticker, **row} for ticker, row in eval_map.items()]})
    client.mutation(
        "meta_versions:set",
        {"key": STATS_GENERATED_AT_KEY, "value": datetime.now(tz=UTC).isoformat()},
    )

    return {
        "positions": len(positions),
        "stats": len(stats_map),
        "evals": len(eval_map),
    }


if __name__ == "__main__":
    load_dotenv(".env")
    result = run_import_from_local_files()
    print(result)
