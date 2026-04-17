"""Define API-side paths and backend configuration values."""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parents[1]
RAW_UI_DIR = BASE_DIR.parent / "ui"


def get_ui_dir(ui_root: Path = RAW_UI_DIR) -> Path:
    """Return the built UI when available, otherwise the raw UI directory."""
    dist_dir = ui_root / "dist"
    dist_index = dist_dir / "index.html"
    return dist_dir if dist_index.exists() else ui_root


def get_index_file(ui_root: Path = RAW_UI_DIR) -> Path:
    """Return the index file for the active UI directory."""
    return get_ui_dir(ui_root) / "index.html"


UI_DIR = get_ui_dir()
INDEX_FILE = get_index_file()
DATA_DIR = BASE_DIR.parent / "data"
DATA_SQLITE_PATH = Path(os.getenv("DATA_SQLITE_PATH", DATA_DIR / "stock_search.db")).expanduser()
SAMPLE_DATA_SQLITE_PATH = Path(os.getenv("SAMPLE_DATA_SQLITE_PATH", DATA_DIR / "sample_stock_search.db")).expanduser()
DATA_STORE_BACKEND = os.getenv("DATA_STORE_BACKEND", "convex").strip().lower() or "convex"
CONVEX_URL = os.getenv("CONVEX_URL", "").strip()
CONVEX_DEPLOY_KEY = os.getenv("CONVEX_DEPLOY_KEY", "").strip()
CONVEX_AUDIENCE = os.getenv("CONVEX_AUDIENCE", "").strip()
CONVEX_SYNC_ENABLED = os.getenv("CONVEX_SYNC_ENABLED", "1").strip().lower() in {"1", "true", "yes", "on"}
