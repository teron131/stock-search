# AGENTS.md (stock_search/api)

This guide is for changes inside `stock_search/api/`.

## Scope

- FastAPI entrypoint, route contracts, and static mounts.
- API-layer orchestration only (no heavy market/eval logic in handlers).
- Data-store orchestration via `stock_search/api/data_store.py` (Convex primary, SQLite local mode).

## High-signal locations

- `stock_search/api/app.py` -> FastAPI app bootstrap, router registration, static mounts.
- `stock_search/api/data_store.py` -> backend-agnostic data access (`convex|sqlite`) for positions/stats/evals.
- `stock_search/models/convex/client.py` -> Convex HTTP adapter (`query`, `mutation`, `action`).
- `stock_search/api/routes/portfolio.py` -> portfolio list/read-write routes and scope policy.
- `stock_search/api/routes/standalone_ticker.py` -> standalone ticker routes (`/api/portfolio/{ticker}`, `/api/stats/{ticker}`).
- `stock_search/api/ticker_standalone.py` -> ticker standalone resolver (`source=auto|live|cache`).
- `stock_search/api/routes/misc.py` -> lightweight eval/news/color utility routes.
- `stock_search/portfolio.py` -> `get_portfolio_payload` consumed by portfolio routes.
- `stock_search/models/convex/import_data.py` -> one-way import from the local SQLite store into Convex tables.

## Key takeaways per location

- `stock_search/api/app.py -> validate_data_backend_on_startup` performs Convex startup check when backend is `convex`.
- `stock_search/api/data_store.py` is the only module that should know whether storage is Convex or SQLite-backed.
- `stock_search/api/routes/portfolio.py -> portfolio_api` controls scope-to-behavior mapping (`priority`, `portfolio_live`, `all`) and response metadata.
- `stock_search/api/routes/standalone_ticker.py` keeps ticker routes standalone and free from portfolio scope/priority behavior.
- `stock_search/api/ticker_standalone.py -> resolve_standalone_ticker_stats` owns `source=auto|live|cache` fallback semantics and live-failure handling.
- `stock_search/api/routes/portfolio.py -> patch_position` validates add/update semantics and normalizes ticker casing before persistence.
- `stock_search/api/routes/portfolio.py -> remove_position` performs idempotent ticker removal from holdings source-of-truth.

## Project-specific conventions and rationale

- Keep route handlers thin; delegate portfolio assembly to `stock_search/portfolio.py`.
- Preserve public API shape while backend storage evolves.
- Preserve source-of-truth policy:
  - default runtime source: Convex (`DATA_STORE_BACKEND=convex`)
  - local runtime source: SQLite (`DATA_STORE_BACKEND=sqlite`)
- Preserve `/api/portfolio` scope behavior:
  - `priority`: cache-only holdings rows, no live market, cache timestamp.
  - `portfolio_live`: holdings rows with live market fetch.
  - `all`: cached universe + live market fetch.
- Scope/priority is portfolio-level only. Do not apply `scope` behavior to ticker endpoints.
- Ticker endpoints are standalone and accept `source=auto|live|cache`:
  - `auto`: try live fetch first, fallback to cached stats from active data store.
  - `live`: live fetch only; return 502 when live fetch fails.
  - `cache`: return cache-only row.
- Preserve response metadata additions:
  - `meta.backend_store`
  - `meta.sync_mode`

## Syntax relationship highlights (ast-grep-first)

- `stock_search/api/app.py` includes routers from `stock_search/api/routes/`.
- `stock_search/api/app.py -> validate_data_backend_on_startup` -> calls `stock_search/models/convex/store.py -> get_meta_value("stats_generated_at")`.
- `stock_search/api/portfolio_store.py` -> delegates reads/writes to `stock_search/api/data_store.py`.
- `stock_search/api/routes/portfolio.py -> portfolio_api` -> calls `stock_search/portfolio.py -> get_portfolio_payload_async`.
- `stock_search/api/routes/standalone_ticker.py` -> calls `stock_search/api/ticker_standalone.py -> resolve_standalone_ticker_stats`.
- `stock_search/api/ticker_standalone.py` -> calls `stock_search/portfolio.py -> fetch_live_stats_async` with cache fallback logic.
- `stock_search/api/routes/portfolio.py -> patch_position` and `stock_search/api/routes/misc.py -> evaluate_ticker_api` -> use `stock_search/indicators.py -> StockIndicator`.
- `stock_search/api/routes/misc.py -> realtime_config_api` -> exposes Convex realtime bootstrap settings for frontend.

## General approach (not rigid checklist)

- When changing request/response shape, update API models first and keep payload compatibility with `ui/preact/usePortfolioData.js`.
- For data semantics changes, prefer editing `stock_search/portfolio.py` instead of adding API-layer transformation logic.
- For new endpoints, align response metadata style (`generated_at`, `data_source`) with existing routes.
- Keep Convex function path strings stable in `data_store.py` unless corresponding Convex module exports are updated and redeployed.

## Validation commands

- Run API locally:
  - `uv run python -m uvicorn stock_search.api:app --reload --host localhost`
- Formatting/lint hook:
  - `/Users/teron/Projects/Agents-Config/.factory/hooks/formatter.sh`
