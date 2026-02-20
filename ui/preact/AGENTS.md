# AGENTS.md (ui/preact)

This guide is for changes inside `ui/preact/`.

## Scope

- Frontend data loading, normalization, and table/dashboard behavior.
- API + static-sample fallback UX.

Primary files:

- `ui/preact/usePortfolioData.js` -> data fetch/orchestration hook
- `ui/preact/dataContract.js` -> payload normalization and compatibility
- `ui/preact/App.js` -> page wiring, refresh cycles, view behavior
- `ui/preact/config.js` -> endpoint and UI constants

## Responsibilities

- Load portfolio data from API in app mode.
- Fall back to static files in demo mode or API failure.
- Keep UI row shape compatible with backend payloads.

## Invariants

- Preserve endpoint contract:
  - `/api/portfolio`
  - `/api/portfolio/{ticker}` for row patch refresh
  - `/api/color-standards`
- Preserve two-stage sync behavior:
  - foreground `priority`, optional background `portfolio_live` backfill.
- Keep ETF behavior:
  - ETF-like rows should not display evaluation scores (`overall_score`, `quality_score`, `valuation_score`, `moat_score`, `upside_score`, etc.).
- Keep static compatibility for both split and dashboard-style payloads.

## Safe Change Pattern

1. Update `dataContract.js` first when payload shape changes.
2. Keep `usePortfolioData.js` authoritative for fetch and merge rules.
3. Keep `App.js` mostly view/event wiring, not data transformation logic.

## Validation

- Manual run through API:
  - `uv run python -m uvicorn stock_search.api:app --reload`
- Format/lint:
  - `/Users/teron/Projects/Agents-Config/.factory/hooks/formatter.sh`
