# AGENTS.md (stock_search/api)

This guide is for changes inside `stock_search/api/`.

## Scope

- FastAPI entrypoint, route contracts, and static mounts.
- API-layer orchestration only (no heavy market/eval logic in handlers).
- Write path for portfolio positions (`data/portfolio.json`).

## High-signal locations

- `stock_search/api/app.py` -> FastAPI app and all routes.
- `stock_search/portfolio.py` -> `get_portfolio_payload` consumed by portfolio routes.
- `stock_search/file_utils.py` -> JSON load/write helpers used by route write paths.

## Key takeaways per location

- `stock_search/api/app.py -> portfolio_api` controls scope-to-behavior mapping (`priority`, `portfolio_live`, `all`) and response metadata.
- `stock_search/api/app.py -> portfolio_ticker_api` is ticker-standalone and does not use portfolio scope/priority.
- `stock_search/api/app.py -> ticker_stats_api` (`/api/stats/{ticker}`) mirrors ticker-standalone behavior for API-only consumers.
- `stock_search/api/app.py -> patch_position` validates add/update semantics and normalizes ticker casing before persistence.
- `stock_search/api/app.py -> remove_position` performs idempotent ticker removal from holdings source-of-truth.

## Project-specific conventions and rationale

- Keep route handlers thin; delegate portfolio assembly to `stock_search/portfolio.py`.
- Preserve source-of-truth write target: `data/portfolio.json`.
- Preserve mount order invariant:
  - `app.mount("/data", ...)` must remain before `app.mount("/", ...)`.
- Preserve `/api/portfolio` scope behavior:
  - `priority`: cache-only holdings rows, no live market, cache timestamp.
  - `portfolio_live`: holdings rows with live market fetch.
  - `all`: cached universe + live market fetch.
- Scope/priority is portfolio-level only. Do not apply `scope` behavior to ticker endpoints.
- Ticker endpoints are standalone and accept `source=auto|live|cache`:
  - `auto`: try live fetch first, fallback to local cache.
  - `live`: live fetch only; return 502 when live fetch fails.
  - `cache`: return cache-only row.

## Syntax relationship highlights (ast-grep-first)

- `stock_search/api/app.py -> portfolio_api` -> calls `stock_search/portfolio.py -> get_portfolio_payload_async`.
- `stock_search/api/app.py -> portfolio_ticker_api` / `ticker_stats_api` -> calls `_resolve_ticker_stats` -> `stock_search/portfolio.py -> fetch_live_stats_async` with cache fallback logic in API layer.
- `stock_search/api/app.py -> patch_position` -> calls `_ensure_valid_new_ticker` -> uses `stock_search/indicators.py -> StockIndicator` for ticker validity.
- `stock_search/api/app.py -> evaluate_ticker_api` -> uses `stock_search/indicators.py -> StockIndicator`.

## General approach (not rigid checklist)

- When changing request/response shape, update API models first and keep payload compatibility with `ui/preact/usePortfolioData.js`.
- For data semantics changes, prefer editing `stock_search/portfolio.py` instead of adding API-layer transformation logic.
- For new endpoints, align response metadata style (`generated_at`, `data_source`) with existing routes.

## Validation commands

- Run API locally:
  - `uv run python -m uvicorn stock_search.api:app --reload`
- Formatting/lint hook:
  - `/Users/teron/Projects/Agents-Config/.factory/hooks/formatter.sh`
