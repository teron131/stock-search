"""Serve Google OAuth login, callback, logout, and session routes."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import PlainTextResponse, RedirectResponse
import httpx

from stock_search.api.auth import (
    SESSION_USER_KEY,
    auth_not_configured_response,
    build_session_user,
    clear_auth_session,
    consume_login_challenge,
    create_google_authorize_url,
    exchange_google_code,
    fetch_google_userinfo,
    get_auth_settings,
    get_session_user,
    new_auth_state,
    sanitize_next_path,
    stash_login_challenge,
)
from stock_search.api.route_paths import AUTH_CALLBACK, AUTH_LOGIN, AUTH_LOGOUT, AUTH_SESSION, ROOT

router = APIRouter()


@router.get(AUTH_LOGIN, name="auth_login")
async def login_api(
    request: Request,
    next_path: str = Query(ROOT, alias="next"),
) -> Response:
    """Start the Google OAuth flow when auth is enabled."""
    settings = get_auth_settings()
    if not settings.enabled:
        return RedirectResponse(url=sanitize_next_path(next_path), status_code=307)
    if not settings.is_configured:
        return auth_not_configured_response()

    state = new_auth_state()
    stash_login_challenge(request, state=state, next_path=next_path)

    return RedirectResponse(
        url=create_google_authorize_url(request, settings, state=state),
        status_code=307,
    )


@router.get(AUTH_CALLBACK, name="auth_callback")
async def callback_api(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> Response:
    """Complete the Google OAuth flow and create the session."""
    settings = get_auth_settings()
    if not settings.enabled:
        return RedirectResponse(url=ROOT, status_code=307)
    if not settings.is_configured:
        return auth_not_configured_response()
    if error:
        return PlainTextResponse(f"Google sign-in failed: {error}", status_code=400)
    if not code or not state:
        return PlainTextResponse("Missing Google OAuth callback parameters.", status_code=400)

    expected_state, next_path = consume_login_challenge(request)
    if not expected_state or state != expected_state:
        clear_auth_session(request)
        return PlainTextResponse("Invalid OAuth state.", status_code=400)

    try:
        token_payload = await exchange_google_code(
            request,
            code=code,
            settings=settings,
        )
        access_token = str(token_payload.get("access_token") or "").strip()
        if not access_token:
            clear_auth_session(request)
            return PlainTextResponse("Missing Google access token.", status_code=502)
        userinfo = await fetch_google_userinfo(access_token=access_token)
    except httpx.HTTPError:
        clear_auth_session(request)
        return PlainTextResponse("Failed to verify Google account.", status_code=502)

    session_user, auth_error = build_session_user(userinfo, settings)
    if auth_error:
        clear_auth_session(request)
        return PlainTextResponse(auth_error, status_code=403)

    request.session[SESSION_USER_KEY] = session_user
    return RedirectResponse(url=next_path, status_code=307)


@router.api_route(AUTH_LOGOUT, methods=["GET", "POST"], name="auth_logout")
async def logout_api(request: Request) -> Response:
    """Clear the authenticated session."""
    settings = get_auth_settings()
    clear_auth_session(request)
    redirect_target = AUTH_LOGIN if settings.enabled else ROOT
    return RedirectResponse(url=redirect_target, status_code=307)


@router.get(AUTH_SESSION, name="auth_session")
def session_api(request: Request, response: Response) -> dict[str, str | bool | None]:
    """Return the current auth/session status for the UI."""
    response.headers["Cache-Control"] = "no-store"
    settings = get_auth_settings()
    current_user = get_session_user(request, settings)
    return {
        "enabled": settings.enabled,
        "authenticated": current_user is not None,
        "email": current_user["email"] if current_user else None,
    }
