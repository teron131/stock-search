"""Import the local SQLite data store into the Convex backend."""

from __future__ import annotations

from datetime import UTC, datetime
import os
from pathlib import Path

from dotenv import load_dotenv

from ...api.config import DATA_SQLITE_PATH
from ...sqlite_store import SQLiteStore
from .client import ConvexHttpAdapter
from .convex_schemas import normalize_portfolio_positions, stock_map_to_rows
from .function_names import (
    CONVEX_META_SET,
    CONVEX_PORTFOLIO_SET,
    CONVEX_STOCK_REPLACE_ALL,
)

STATS_GENERATED_AT_KEY = "stats_generated_at"


def run_import_from_local_store(
    *,
    db_path: Path = DATA_SQLITE_PATH,
) -> dict[str, int]:
    """Push the local portfolio and stock data store into Convex."""
    client = ConvexHttpAdapter(
        base_url=os.getenv("CONVEX_URL", ""),
        deploy_key=os.getenv("CONVEX_DEPLOY_KEY", ""),
    )
    store = SQLiteStore(db_path)
    positions = normalize_portfolio_positions(store.load_positions())
    merged_stock_map = store.load_stocks()

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


def run_import_from_local_files(
    *,
    db_path: Path = DATA_SQLITE_PATH,
    portfolio_path: Path | None = None,
    stats_path: Path | None = None,
    eval_path: Path | None = None,
) -> dict[str, int]:
    """Deprecated compatibility wrapper for the old JSON import entrypoint."""
    if portfolio_path is not None or stats_path is not None or eval_path is not None:
        raise ValueError("JSON-based import arguments were removed. Use db_path or run_import_from_local_store() with the local SQLite database instead.")
    return run_import_from_local_store(db_path=db_path)


if __name__ == "__main__":
    load_dotenv(".env")
    result = run_import_from_local_store()
    print(result)
