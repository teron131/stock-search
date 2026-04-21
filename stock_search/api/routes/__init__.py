"""Export the API routers used by the FastAPI app."""

from .auth import router as auth_router
from .misc import router as misc_router
from .portfolio import router as portfolio_router
from .standalone_ticker import router as standalone_ticker_router

__all__ = [
    "auth_router",
    "misc_router",
    "portfolio_router",
    "standalone_ticker_router",
]
