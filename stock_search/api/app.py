"""Create the FastAPI app and mount the dashboard assets."""

from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from stock_search.api.auth import AuthGuardMiddleware, get_auth_settings
from stock_search.api.config import CONVEX_DEPLOY_KEY, CONVEX_URL, INDEX_FILE, UI_DIR
from stock_search.api.data_store import backend_name
from stock_search.api.route_paths import CALENDAR, DASHBOARD, INDUSTRY, MARKETMAP, ROOT
from stock_search.api.routes import auth_router, misc_router, portfolio_router, standalone_ticker_router
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


def serve_index_file() -> FileResponse:
    """Serve the dashboard index file."""
    return FileResponse(INDEX_FILE)


def create_app() -> FastAPI:
    """Create the FastAPI application with auth and static assets configured."""
    settings = get_auth_settings()
    api = FastAPI(title="Stock Search Dashboard", lifespan=lifespan)
    api.add_middleware(AuthGuardMiddleware)
    api.add_middleware(
        SessionMiddleware,
        secret_key=settings.secret,
        same_site="lax",
        https_only=settings.enabled,
        session_cookie="stock_search_session",
        max_age=7 * 24 * 60 * 60,
    )

    @api.get(ROOT)
    @api.get(DASHBOARD)
    @api.get(INDUSTRY)
    @api.get(MARKETMAP)
    @api.get(CALENDAR)
    def serve_dashboard() -> FileResponse:
        """Serve client-side dashboard routes."""
        return serve_index_file()

    api.include_router(auth_router)
    api.include_router(portfolio_router)
    api.include_router(standalone_ticker_router)
    api.include_router(misc_router)
    api.mount("/", StaticFiles(directory=UI_DIR), name="ui")
    return api


app = create_app()
