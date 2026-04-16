"""Define API-side paths and backend configuration values."""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parents[1]
UI_DIR = BASE_DIR.parent / "ui"
INDEX_FILE = UI_DIR / "index.html"
DATA_DIR = BASE_DIR.parent / "data"
DATA_SQLITE_PATH = Path(os.getenv("DATA_SQLITE_PATH", DATA_DIR / "stock_search.db")).expanduser()
SAMPLE_DATA_SQLITE_PATH = Path(os.getenv("SAMPLE_DATA_SQLITE_PATH", DATA_DIR / "sample_stock_search.db")).expanduser()
DATA_STORE_BACKEND = os.getenv("DATA_STORE_BACKEND", "convex").strip().lower() or "convex"
CONVEX_URL = os.getenv("CONVEX_URL", "").strip()
CONVEX_DEPLOY_KEY = os.getenv("CONVEX_DEPLOY_KEY", "").strip()
CONVEX_AUDIENCE = os.getenv("CONVEX_AUDIENCE", "").strip()
CONVEX_SYNC_ENABLED = os.getenv("CONVEX_SYNC_ENABLED", "1").strip().lower() in {"1", "true", "yes", "on"}
