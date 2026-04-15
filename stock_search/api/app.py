"""Create the FastAPI app and mount the dashboard assets."""

from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from stock_search.api.config import CONVEX_DEPLOY_KEY, CONVEX_URL, DATA_DIR, INDEX_FILE, UI_DIR
from stock_search.api.data_store import backend_name
from stock_search.api.routes import misc_router, portfolio_router, standalone_ticker_router
from stock_search.models.convex.store import ConvexStore

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Run startup checks for the FastAPI application."""
    if backend_name() == "convex":
        store = ConvexStore(
            base_url=CONVEX_URL,
            deploy_key=CONVEX_DEPLOY_KEY,
        )
        try:
            store.get_meta_value("stats_generated_at")
        except Exception as exc:
            message = "Convex data store startup check failed. Verify CONVEX_URL, CONVEX_DEPLOY_KEY, and deployed Convex functions."
            logger.exception(message)
            raise RuntimeError(message) from exc
    yield


app = FastAPI(title="Stock Search Dashboard", lifespan=lifespan)

# Expose backend `data/` to the UI (portfolio/eval/stats JSON)
# This must be mounted before the UI mount at "/".
app.mount("/data", StaticFiles(directory=DATA_DIR), name="data")


@app.get("/")
def serve_index() -> FileResponse:
    """Serve the dashboard index file."""
    return FileResponse(INDEX_FILE)


app.include_router(portfolio_router)
app.include_router(standalone_ticker_router)
app.include_router(misc_router)

app.mount("/", StaticFiles(directory=UI_DIR), name="ui")
