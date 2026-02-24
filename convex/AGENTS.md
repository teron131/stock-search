# AGENTS.md (convex module)

This guide is for changes inside `convex/`.

## Scope

- Convex schema and server functions for cloud data storage.
- Data contract surface consumed by Python (`stock_search/api/data_store.py`) and frontend realtime subscriptions (`ui/preact/usePortfolioData.js`).
- Indexes and function identifiers that must remain stable for API compatibility.

## High-signal locations

- `convex/schema.ts` -> table definitions and indexes.
- `convex/portfolio.ts` -> portfolio query/mutation (`get`, `set`).
- `convex/stock.ts` -> stock query/mutation (`list`, `get`, `replaceAll`).
- `convex/news.ts` -> news query/mutation (`list`, `replaceAll`).
- `convex/meta_versions.ts` -> metadata key/value query/mutation (`get`, `set`).
- `convex/_generated/*` -> generated API/model bindings used by Convex runtime tooling.

## Key takeaways per location

- `convex/schema.ts` is the source of truth for storage shape and index names; index name changes are breaking.
- `convex/portfolio.ts -> set` is upsert-by-key semantics for aggregate portfolio state.
- `convex/stock.ts -> replaceAll` is full replacement semantics for stock snapshots.
- `convex/meta_versions.ts` stores operational metadata such as `stats_generated_at`.

## Project-specific conventions and rationale

- Keep function identifiers stable:
  - `portfolio:get`, `portfolio:set`
  - `stock:list`, `stock:get`, `stock:replaceAll`
  - `news:list`, `news:replaceAll`
  - `meta_versions:get`, `meta_versions:set`
- Preserve uppercase/trim normalization of ticker keys at mutation boundaries.
- Treat `replaceAll` functions as migration/bootstrap primitives. Do not silently switch to partial upserts without updating Python callers.

## Syntax relationship highlights (ast-grep-first)

- `convex/schema.ts -> defineSchema` declares `stocks`, `portfolios`, `news`, `meta_versions`.
- `convex/portfolio.ts -> get/set` reads/writes `portfolios` table and `by_key` index.
- `convex/stock.ts -> list/get/replaceAll` reads/writes `stocks` table and `by_ticker` index.
- `convex/news.ts -> list/replaceAll` reads/writes `news` table and `by_key` index.
- `convex/meta_versions.ts -> get/set` reads/writes `meta_versions` table and `by_key` index.

## General approach (not rigid checklist)

- Update `schema.ts` first, then align functions, then redeploy, then regenerate `_generated`.
- When changing storage shape, preserve backward-compatible read paths in `list/get` before tightening write validators.
- Prefer additive schema changes over destructive reshapes during active migration.

## Validation commands

- Deploy Convex:
  - `npx convex deploy -y --typecheck disable --env-file .env`
- Bootstrap data:
  - `uv run python -m stock_search.api.import_convex_data`
- API smoke after deploy:
  - `uv run python - <<'PY'\nfrom dotenv import load_dotenv\nload_dotenv('.env')\nfrom fastapi.testclient import TestClient\nfrom stock_search.api.app import app\nwith TestClient(app) as client:\n    print(client.get('/api/portfolio?scope=priority').status_code)\nPY`
