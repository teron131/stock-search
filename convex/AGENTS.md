# Convex Backend (Cloud Source of Truth)

This folder defines the Convex schema and server functions used by the FastAPI backend and UI realtime sync.

## Tables

- `positions`: holdings (`ticker`, `quantity`, `strategy`, `updatedAt`)
- `stats`: cacheable market data rows (`ticker`, `row`, source/timestamps)
- `evals`: scoring/evaluation rows (`ticker`, `row`, `updatedAt`)
- `meta_versions`: metadata/version markers (`key`, `value`, `updatedAt`)

## Functions used by Python backend

- `positions:list`
- `positions:replaceAll`
- `stats:list`
- `stats:getByTicker`
- `stats:replaceAll`
- `evals:list`
- `evals:getByTicker`
- `evals:replaceAll`
- `meta_versions:get`
- `meta_versions:set`

## Bootstrap local JSON into Convex

From repo root (after setting `CONVEX_URL` and `CONVEX_DEPLOY_KEY`):

```bash
uv run python -m stock_search.api.import_convex_data
```
