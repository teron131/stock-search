from fastapi.testclient import TestClient

import stock_search.api.app as app_module
import stock_search.api.routes.auth as auth_routes


def _build_auth_app(monkeypatch) -> TestClient:
    monkeypatch.setattr(app_module, "backend_name", lambda: "file")
    return TestClient(app_module.create_app(), base_url="https://testserver")


def _enable_auth_env(monkeypatch) -> None:
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("AUTH_SECRET", "test-secret")
    monkeypatch.setenv("AUTH_GOOGLE_ID", "google-client-id")
    monkeypatch.setenv("AUTH_GOOGLE_SECRET", "google-client-secret")
    monkeypatch.setenv("ALLOWED_EMAIL", "allowed@example.com")


def test_auth_disabled_keeps_root_public(monkeypatch) -> None:
    with _build_auth_app(monkeypatch) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")


def test_auth_disabled_reports_session_state(monkeypatch) -> None:
    with _build_auth_app(monkeypatch) as client:
        response = client.get("/auth/session")

    assert response.status_code == 200
    assert response.json() == {
        "enabled": False,
        "authenticated": False,
        "email": None,
    }


def test_auth_enabled_redirects_page_routes_without_session(monkeypatch) -> None:
    _enable_auth_env(monkeypatch)

    with _build_auth_app(monkeypatch) as client:
        response = client.get("/dashboard", follow_redirects=False)

    assert response.status_code == 307
    assert response.headers["location"] == "https://testserver/auth/login?next=%2Fdashboard"


def test_auth_enabled_returns_401_for_api_routes_without_session(monkeypatch) -> None:
    _enable_auth_env(monkeypatch)

    with _build_auth_app(monkeypatch) as client:
        response = client.get("/portfolio")

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}


def test_google_callback_accepts_allowed_email(monkeypatch) -> None:
    _enable_auth_env(monkeypatch)
    captured_state: list[str] = []

    def fake_authorize_url(request, settings, *, state: str) -> str:
        captured_state.append(state)
        return f"https://accounts.example.com?state={state}"

    async def fake_exchange_code(request, *, code: str, settings):
        assert code == "auth-code"
        return {"access_token": "access-token"}

    async def fake_userinfo(*, access_token: str):
        assert access_token == "access-token"
        return {
            "email": "allowed@example.com",
            "email_verified": True,
            "name": "Allowed User",
            "sub": "google-subject",
        }

    monkeypatch.setattr(auth_routes, "create_google_authorize_url", fake_authorize_url)
    monkeypatch.setattr(auth_routes, "exchange_google_code", fake_exchange_code)
    monkeypatch.setattr(auth_routes, "fetch_google_userinfo", fake_userinfo)

    with _build_auth_app(monkeypatch) as client:
        login_response = client.get("/auth/login?next=/dashboard", follow_redirects=False)
        callback_response = client.get(
            f"/auth/callback?code=auth-code&state={captured_state[0]}",
            follow_redirects=False,
        )
        session_response = client.get("/auth/session")

    assert login_response.status_code == 307
    assert login_response.headers["location"].startswith("https://accounts.example.com")
    assert callback_response.status_code == 307
    assert callback_response.headers["location"] == "/dashboard"
    assert session_response.json() == {
        "enabled": True,
        "authenticated": True,
        "email": "allowed@example.com",
    }


def test_google_callback_rejects_unverified_or_unallowed_accounts(monkeypatch) -> None:
    _enable_auth_env(monkeypatch)
    captured_state: list[str] = []

    def fake_authorize_url(request, settings, *, state: str) -> str:
        captured_state.append(state)
        return f"https://accounts.example.com?state={state}"

    async def fake_exchange_code(request, *, code: str, settings):
        assert code == "auth-code"
        return {"access_token": "access-token"}

    async def fake_userinfo(*, access_token: str):
        return {
            "email": "blocked@example.com",
            "email_verified": True,
        }

    monkeypatch.setattr(auth_routes, "create_google_authorize_url", fake_authorize_url)
    monkeypatch.setattr(auth_routes, "exchange_google_code", fake_exchange_code)
    monkeypatch.setattr(auth_routes, "fetch_google_userinfo", fake_userinfo)

    with _build_auth_app(monkeypatch) as client:
        client.get("/auth/login?next=/", follow_redirects=False)
        callback_response = client.get(
            f"/auth/callback?code=auth-code&state={captured_state[0]}",
            follow_redirects=False,
        )
        session_response = client.get("/auth/session")

    assert callback_response.status_code == 403
    assert callback_response.text == "Google account is not allowed."
    assert session_response.json() == {
        "enabled": True,
        "authenticated": False,
        "email": None,
    }


def test_logout_clears_session_and_reprotects_app(monkeypatch) -> None:
    _enable_auth_env(monkeypatch)
    captured_state: list[str] = []

    def fake_authorize_url(request, settings, *, state: str) -> str:
        captured_state.append(state)
        return f"https://accounts.example.com?state={state}"

    async def fake_exchange_code(request, *, code: str, settings):
        assert code == "auth-code"
        return {"access_token": "access-token"}

    async def fake_userinfo(*, access_token: str):
        return {
            "email": "allowed@example.com",
            "email_verified": True,
        }

    monkeypatch.setattr(auth_routes, "create_google_authorize_url", fake_authorize_url)
    monkeypatch.setattr(auth_routes, "exchange_google_code", fake_exchange_code)
    monkeypatch.setattr(auth_routes, "fetch_google_userinfo", fake_userinfo)

    with _build_auth_app(monkeypatch) as client:
        client.get("/auth/login?next=/", follow_redirects=False)
        client.get(
            f"/auth/callback?code=auth-code&state={captured_state[0]}",
            follow_redirects=False,
        )
        logout_response = client.get("/auth/logout", follow_redirects=False)
        protected_response = client.get("/", follow_redirects=False)

    assert logout_response.status_code == 307
    assert logout_response.headers["location"] == "/auth/login"
    assert protected_response.status_code == 307
    assert protected_response.headers["location"] == "https://testserver/auth/login?next=%2F"
