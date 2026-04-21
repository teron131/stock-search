"""Google OAuth session helpers and auth middleware for the FastAPI app."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import PurePosixPath
import secrets
from typing import Any
from urllib.parse import urlencode

from fastapi import Request
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse
import httpx
from starlette.middleware.base import BaseHTTPMiddleware

from stock_search.api.route_paths import (
    AUTH_CALLBACK,
    AUTH_LOGIN,
    AUTH_LOGOUT,
    AUTH_SESSION,
    DASHBOARD_PAGE_PATHS,
    ROOT,
)

TRUTHY_VALUES = {"1", "true", "yes", "on"}
DEFAULT_AUTH_SECRET = "stock-search-auth-disabled"
AUTH_ERROR_TEXT = "Authentication is not fully configured."
AUTH_REQUIRED_DETAIL = "Authentication required"
SESSION_AUTH_NEXT_KEY = "auth_next"
SESSION_AUTH_STATE_KEY = "auth_state"
SESSION_USER_KEY = "user"

GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

PUBLIC_AUTH_PATHS = {
    AUTH_LOGIN,
    AUTH_CALLBACK,
    AUTH_LOGOUT,
    AUTH_SESSION,
}
PUBLIC_STATIC_PREFIXES = (
    "/assets/",
    "/demo/",
    "/.well-known/",
)
PUBLIC_STATIC_EXTENSIONS = {
    ".avif",
    ".bmp",
    ".css",
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".json",
    ".map",
    ".png",
    ".svg",
    ".txt",
    ".webmanifest",
    ".webp",
    ".woff",
    ".woff2",
}


@dataclass(slots=True)
class AuthSettings:
    """Capture auth-related configuration read from the environment."""

    enabled: bool
    secret: str
    google_client_id: str
    google_client_secret: str
    allowed_email: str

    @property
    def is_configured(self) -> bool:
        """Return whether auth has the minimum required configuration."""
        return bool(self.secret and self.google_client_id and self.google_client_secret and self.allowed_email)


def normalize_email(email: str | None) -> str:
    """Normalize an email address for consistent comparisons."""
    return str(email or "").strip().lower()


def get_auth_settings() -> AuthSettings:
    """Read auth settings directly from the environment."""
    enabled = os.getenv("AUTH_ENABLED", "false").strip().lower() in TRUTHY_VALUES
    secret = os.getenv("AUTH_SECRET", "").strip() or DEFAULT_AUTH_SECRET
    return AuthSettings(
        enabled=enabled,
        secret=secret,
        google_client_id=os.getenv("AUTH_GOOGLE_ID", "").strip(),
        google_client_secret=os.getenv("AUTH_GOOGLE_SECRET", "").strip(),
        allowed_email=normalize_email(os.getenv("ALLOWED_EMAIL")),
    )


def is_public_request_path(path: str) -> bool:
    """Return whether a path should stay public even when auth is enabled."""
    if path in PUBLIC_AUTH_PATHS or path == "/favicon.ico":
        return True
    if path.startswith(PUBLIC_STATIC_PREFIXES):
        return True
    return PurePosixPath(path).suffix.lower() in PUBLIC_STATIC_EXTENSIONS


def sanitize_next_path(next_path: str | None) -> str:
    """Keep post-login redirects inside this app."""
    candidate = str(next_path or "").strip()
    if not candidate.startswith("/") or candidate.startswith("//"):
        return ROOT
    return candidate


def get_session_user(request: Request, settings: AuthSettings) -> dict[str, Any] | None:
    """Return the authenticated session user when present and allowed."""
    session_user = request.session.get(SESSION_USER_KEY)
    if not isinstance(session_user, dict):
        return None

    email = normalize_email(session_user.get("email"))
    if not email or email != settings.allowed_email:
        request.session.pop(SESSION_USER_KEY, None)
        return None

    return {
        "email": email,
        "name": str(session_user.get("name") or "").strip() or None,
        "sub": str(session_user.get("sub") or "").strip() or None,
    }


def auth_not_configured_response() -> PlainTextResponse:
    """Return the standard response for missing auth configuration."""
    return PlainTextResponse(AUTH_ERROR_TEXT, status_code=503)


def clear_auth_session(request: Request) -> None:
    """Remove all auth-related data from the session."""
    request.session.pop(SESSION_AUTH_STATE_KEY, None)
    request.session.pop(SESSION_AUTH_NEXT_KEY, None)
    request.session.pop(SESSION_USER_KEY, None)


def stash_login_challenge(request: Request, *, state: str, next_path: str) -> None:
    """Store the OAuth challenge state and post-login redirect target."""
    request.session[SESSION_AUTH_STATE_KEY] = state
    request.session[SESSION_AUTH_NEXT_KEY] = sanitize_next_path(next_path)


def consume_login_challenge(request: Request) -> tuple[str, str]:
    """Pop the expected OAuth state and post-login redirect target."""
    expected_state = str(request.session.pop(SESSION_AUTH_STATE_KEY, "")).strip()
    next_path = sanitize_next_path(request.session.pop(SESSION_AUTH_NEXT_KEY, ROOT))
    return expected_state, next_path


def build_session_user(
    userinfo: dict[str, Any],
    settings: AuthSettings,
) -> tuple[dict[str, str | None] | None, str | None]:
    """Validate Google userinfo and return a session-safe user payload."""
    email = normalize_email(userinfo.get("email"))
    is_verified = bool(userinfo.get("email_verified") or userinfo.get("verified_email"))
    if not email:
        return None, "Google account is missing an email."
    if not is_verified:
        return None, "Google email is not verified."
    if email != settings.allowed_email:
        return None, "Google account is not allowed."

    return (
        {
            "email": email,
            "name": str(userinfo.get("name") or "").strip() or None,
            "sub": str(userinfo.get("sub") or "").strip() or None,
        },
        None,
    )


def create_google_authorize_url(
    request: Request,
    settings: AuthSettings,
    *,
    state: str,
) -> str:
    """Build the Google authorization URL for the current request."""
    query = urlencode(
        {
            "client_id": settings.google_client_id,
            "redirect_uri": str(request.url_for("auth_callback")),
            "response_type": "code",
            "scope": "openid email profile",
            "state": state,
            "prompt": "select_account",
        }
    )
    return f"{GOOGLE_AUTHORIZE_URL}?{query}"


async def exchange_google_code(
    request: Request,
    *,
    code: str,
    settings: AuthSettings,
) -> dict[str, Any]:
    """Exchange a Google auth code for OAuth tokens."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": str(request.url_for("auth_callback")),
                "grant_type": "authorization_code",
            },
        )
    response.raise_for_status()
    return response.json()


async def fetch_google_userinfo(*, access_token: str) -> dict[str, Any]:
    """Fetch the authenticated Google user profile."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )
    response.raise_for_status()
    return response.json()


class AuthGuardMiddleware(BaseHTTPMiddleware):
    """Enforce app auth centrally while keeping public assets accessible."""

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        settings = get_auth_settings()
        request.state.auth_enabled = settings.enabled
        request.state.current_user = get_session_user(request, settings)
        path = request.url.path

        if not settings.enabled or is_public_request_path(path):
            return await call_next(request)

        if not settings.is_configured:
            return auth_not_configured_response()

        if request.state.current_user is not None:
            return await call_next(request)

        if path in DASHBOARD_PAGE_PATHS:
            next_path = path
            if request.url.query:
                next_path = f"{next_path}?{request.url.query}"
            login_url = request.url_for("auth_login")
            return RedirectResponse(
                url=f"{login_url}?{urlencode({'next': sanitize_next_path(next_path)})}",
                status_code=307,
            )

        return JSONResponse({"detail": AUTH_REQUIRED_DETAIL}, status_code=401)


def new_auth_state() -> str:
    """Create a new OAuth state token."""
    return secrets.token_urlsafe(32)
