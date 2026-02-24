from __future__ import annotations

from datetime import UTC, datetime
import os
from pathlib import Path

from dotenv import load_dotenv

from ...api.config import EVAL_PATH, PORTFOLIO_PATH, STATS_PATH
from ...file_utils import load_json
from ...utils import normalize_ticker_symbol
from .client import ConvexHttpAdapter
from .convex_schemas import normalize_portfolio_positions, stock_map_to_rows
from .function_names import (
    CONVEX_META_SET,
    CONVEX_PORTFOLIO_SET,
    CONVEX_STOCK_REPLACE_ALL,
)

STATS_GENERATED_AT_KEY = "stats_generated_at"


def _load_positions(path: Path) -> list[dict[str, object]]:
    payload = load_json(path, default=[])
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        positions = payload.get("positions", [])
        if isinstance(positions, list):
            return [row for row in positions if isinstance(row, dict)]
    return []


def _load_ticker_map(path: Path) -> dict[str, dict[str, object]]:
    payload = load_json(path, default={})
    if not isinstance(payload, dict):
        return {}
    return {ticker_symbol: row for ticker, row in payload.items() if isinstance(row, dict) and (ticker_symbol := normalize_ticker_symbol(ticker))}


def run_import_from_local_files(
    *,
    portfolio_path: Path = PORTFOLIO_PATH,
    stats_path: Path = STATS_PATH,
    eval_path: Path = EVAL_PATH,
) -> dict[str, int]:
    client = ConvexHttpAdapter(
        base_url=os.getenv("CONVEX_URL", ""),
        deploy_key=os.getenv("CONVEX_DEPLOY_KEY", ""),
    )
    positions = normalize_portfolio_positions(_load_positions(portfolio_path))
    stats_map = _load_ticker_map(stats_path)
    eval_map = _load_ticker_map(eval_path)
    merged_stock_map: dict[str, dict[str, object]] = {}
    for ticker, stats_row in stats_map.items():
        merged_stock_map[ticker] = {
            "indicators": dict(stats_row),
            "evaluation": {},
            "labels": [],
        }
    for ticker, eval_row in eval_map.items():
        existing = merged_stock_map.setdefault(
            ticker,
            {
                "indicators": {},
                "evaluation": {},
                "labels": [],
            },
        )
        existing["evaluation"] = dict(eval_row)

    client.mutation(
        CONVEX_PORTFOLIO_SET,
        {
            "key": "default",
            "positions": positions,
        },
    )
    client.mutation(
        CONVEX_STOCK_REPLACE_ALL,
        {
            "rows": stock_map_to_rows(merged_stock_map),
        },
    )
    client.mutation(
        CONVEX_META_SET,
        {
            "key": STATS_GENERATED_AT_KEY,
            "value": datetime.now(tz=UTC).isoformat(),
        },
    )

    return {
        "positions": len(positions),
        "stocks": len(merged_stock_map),
    }


if __name__ == "__main__":
    load_dotenv(".env")
    result = run_import_from_local_files()
    print(result)
