from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import pandas as pd

from stock_search.dashboard import get_dashboard

BASE_DIR = Path(__file__).resolve().parent
UI_DIR = BASE_DIR.parent / "ui"
INDEX_FILE = UI_DIR / "index.html"

app = FastAPI(title="Stock Search Dashboard")

app.mount("/static", StaticFiles(directory=UI_DIR), name="static")


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(INDEX_FILE)


@app.get("/api/dashboard")
def dashboard_api(portfolio_path: str = "portfolio.json") -> dict:
    df = get_dashboard(portfolio_path)
    df = df.where(pd.notna(df), None)
    return {
        "columns": list(df.columns),
        "rows": df.to_dict(orient="records"),
    }
