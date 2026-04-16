from collections.abc import Iterator

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

import stock_search.api.routes.misc as misc_routes

TEST_LLM_MODEL = "openai/gpt-5.4-nano"
PAID_API_ENV_KEYS = (
    "LLM_API_KEY",
    "EXA_API_KEY",
    "NEWS_API_KEY",
    "NEWSDATA_API_KEY",
    "MASSIVE_API_KEY",
    "GEMINI_API_KEY",
    "OPENCODE_API_KEY",
    "AI_GATEWAY_API_KEY",
)


@pytest.fixture
def misc_client() -> Iterator[TestClient]:
    api = FastAPI()
    api.include_router(misc_routes.router)
    with TestClient(api) as client:
        yield client


@pytest.fixture(autouse=True)
def force_test_llm_model(monkeypatch) -> None:
    monkeypatch.setenv("FAST_LLM", TEST_LLM_MODEL)
    monkeypatch.setenv("QUALITY_LLM", TEST_LLM_MODEL)


@pytest.fixture(autouse=True)
def disable_paid_api_credentials(monkeypatch) -> None:
    for key in PAID_API_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
