# AGENTS.md (stock_search/api)

This guide is for changes inside `stock_search/api/`.

## Scope

- API entrypoint and HTTP contracts.
- Route-level orchestration only.
- Static UI/data mounts and request/response behavior.

Primary file:

- `stock_search/api/app.py` -> module `app`

## Responsibilities

- Define FastAPI routes and request models.
- Delegate portfolio assembly to `stock_search.portfolio.get_portfolio_payload`.
- Persist position edits to `data/portfolio.json`.
- Expose supporting endpoints (`/api/eval`, `/api/color-standards`).

## Invariants

- Keep `portfolio.json` as holdings source-of-truth for write operations.
- Do not move market/eval business logic into route handlers.
- Preserve scope behavior for `/api/portfolio`:
  - `priority`: no live market, no cached universe, cache timestamp
  - `portfolio_live`: live market only for holdings
  - `all`: full universe + live market
- Keep UI mount order stable:
  - `app.mount("/data", ...)` must remain before `app.mount("/", ...)`.

## Safe Change Pattern

1. Add/adjust request validation in Pydantic models.
2. Keep handlers thin and delegate to service/orchestration modules.
3. Preserve response shape used by `ui/preact/usePortfolioData.js`.

## Validation

- Start server:
  - `uv run python -m uvicorn stock_search.api:app --reload`
- Format/lint:
  - `/Users/teron/Projects/Agents-Config/.factory/hooks/formatter.sh`
