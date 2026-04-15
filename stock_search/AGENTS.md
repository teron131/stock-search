# AGENTS.md (stock_search package modules)

This guide is for changes inside `stock_search/` and maps how modules connect.

## Scope

- Package-level orchestration across API, portfolio assembly, indicators, and providers.
- Data flow between Convex cloud tables and optional local JSON fallback/bootstrap files.
- How to change modules safely without breaking UI/API contracts.

## High-signal locations

- `stock_search/api/app.py` -> FastAPI entrypoint/bootstrap and router registration.
- `stock_search/api/data_store.py` -> unified storage boundary (`convex|file`) for positions/stats/evals.
- `stock_search/models/convex/client.py` -> Convex HTTP transport wrapper.
- `stock_search/api/routes/portfolio.py` -> portfolio scope route behavior and portfolio write APIs.
- `stock_search/api/routes/standalone_ticker.py` -> ticker-standalone route handlers.
- `stock_search/api/ticker_standalone.py` -> standalone ticker fallback resolver.
- `stock_search/portfolio.py` -> portfolio payload orchestration and row assembly.
- `stock_search/indicators.py` -> source precedence wrapper (`StockIndicator`).
- `stock_search/data_sources/yahoofinance.py` -> Yahoo provider adapter.
- `stock_search/data_sources/stockanalysis/source.py` -> StockAnalysis provider adapter.
- `stock_search/evaluation/normalization.py` -> eval field normalization and aliases.
- `stock_search/evaluation/evaluation.py` -> model/input assembly and score pipeline.

## Key takeaways per location

- `stock_search/api/routes/portfolio.py` -> `portfolio_api` calls `get_portfolio_payload_async(...)`; portfolio handlers should stay thin and avoid embedding market logic.
- `stock_search/api/data_store.py` is the storage seam: most modules should not call Convex directly.
- `stock_search/api/routes/standalone_ticker.py` -> standalone ticker endpoints delegate to `resolve_standalone_ticker_stats(...)`.
- `stock_search/portfolio.py` -> `_build_row` merges cache + optional live values, then resolves eval with LLM-first and deterministic fallback.
- `stock_search/portfolio.py` -> `get_portfolio_payload` is the central assembly point used by API and dataframe helpers.
- `stock_search/indicators.py` -> `StockIndicator` resolves fundamental fields with StockAnalysis-first and Yahoo fallback; price/momentum remain Yahoo-led.
- `stock_search/data_sources/yahoofinance.py` -> source-local extraction only; no cross-provider policy belongs here.
- `stock_search/data_sources/stockanalysis/source.py` -> statistics/financials/ETF extraction with scrape-first then web-search fallback.

## Project-specific conventions and rationale

- Default source-of-truth is Convex tables (`positions`, `stats`, `evals`, `meta_versions`) via `stock_search/api/data_store.py`.
- Keep local JSON files as fallback/bootstrap artifacts:
  - `data/portfolio.json`
  - `data/stats.json`
  - `data/eval.json`
- Use `stock_search/models/convex/import_data.py` for one-way bootstrap from local JSON into Convex.
- Preserve source precedence policy:
  - Fundamentals: StockAnalysis primary, cached values secondary, Yahoo fallback.
  - Live market fields: Yahoo snapshot/cache path.
- Preserve forward P/E policy in Yahoo adapter (`get_forward_pe_ntm`): NTM FY0/FY1 blend first, FY1 fallback second.

## Syntax relationship highlights (ast-grep-first)

- `stock_search/api/app.py` -> includes routers from `stock_search/api/routes/`.
- `stock_search/api/app.py -> validate_data_backend_on_startup` -> checks Convex connectivity with `meta_versions:get`.
- `stock_search/api/routes/portfolio.py -> portfolio_api` -> calls `stock_search/portfolio.py -> get_portfolio_payload_async`.
- `stock_search/api/routes/standalone_ticker.py` -> calls `stock_search/api/ticker_standalone.py -> resolve_standalone_ticker_stats`.
- `stock_search/api/portfolio_store.py` -> delegates to `stock_search/api/data_store.py`.
- `stock_search/evaluation/evaluation.py -> build_inputs` -> instantiates `stock_search/indicators.py -> StockIndicator`.
- `stock_search/api/routes/portfolio.py -> _ensure_valid_new_ticker` and `stock_search/api/routes/misc.py -> evaluate_ticker_api` -> instantiate `stock_search/indicators.py -> StockIndicator`.
- `stock_search/indicators.py -> StockIndicator` -> composes `YahooFinanceSource` + `StockAnalysisSource` and resolves field-by-field fallback.

## General approach (not rigid checklist)

- Start from API contract changes, then trace into portfolio assembly and provider boundaries.
- Prefer changing one layer at a time:
  - Request/response validation in `api/`.
  - Merge/ranking/weight logic in `portfolio.py`.
  - Raw extraction/normalization in `data_sources/`.
- Keep provider modules source-local and move precedence decisions to `indicators.py` or portfolio orchestration.

## Validation commands

- Server smoke run:
  - `uv run python -m uvicorn stock_search.api:app --reload`
- Formatter/lint hook:
  - `/Users/teron/Projects/Agents-Config/.factory/hooks/formatter.sh`

## Notes

- This repository currently has no `stock_search/mcp/` module on disk.
- Existing module docs to keep aligned with this package map:
  - `stock_search/api/AGENTS.md`
  - `stock_search/data_sources/AGENTS.md`
  - `stock_search/evaluation/AGENTS.md`
  - `stock_search/news/AGENTS.md`
