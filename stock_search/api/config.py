import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parents[1]
UI_DIR = BASE_DIR.parent / "ui"
INDEX_FILE = UI_DIR / "index.html"
DATA_DIR = BASE_DIR.parent / "data"
PORTFOLIO_PATH = DATA_DIR / "portfolio.json"
STATS_PATH = DATA_DIR / "stats.json"
EVAL_PATH = DATA_DIR / "eval.json"
DATA_STORE_BACKEND = os.getenv("DATA_STORE_BACKEND", "convex").strip().lower() or "convex"
CONVEX_URL = os.getenv("CONVEX_URL", "").strip()
CONVEX_DEPLOY_KEY = os.getenv("CONVEX_DEPLOY_KEY", "").strip()
CONVEX_AUDIENCE = os.getenv("CONVEX_AUDIENCE", "").strip()
CONVEX_SYNC_ENABLED = os.getenv("CONVEX_SYNC_ENABLED", "1").strip().lower() in {"1", "true", "yes", "on"}
