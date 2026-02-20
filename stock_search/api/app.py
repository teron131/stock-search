from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from stock_search.api.config import DATA_DIR, INDEX_FILE, UI_DIR
from stock_search.api.routes import misc_router, portfolio_router, standalone_ticker_router

app = FastAPI(title="Stock Search Dashboard")

# Expose backend `data/` to the UI (portfolio/eval/stats JSON)
# This must be mounted before the UI mount at "/".
app.mount("/data", StaticFiles(directory=DATA_DIR), name="data")


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(INDEX_FILE)


app.include_router(portfolio_router)
app.include_router(standalone_ticker_router)
app.include_router(misc_router)


app.mount("/", StaticFiles(directory=UI_DIR), name="ui")
