# AGENTS.md (stock_search/data_sources)

This guide is for changes inside `stock_search/data_sources/`.

## Scope

- Provider-local extraction and normalization.
- Snapshot/dataclass shaping for Yahoo and StockAnalysis sources.
- No cross-provider precedence policy in this folder.

## High-signal locations

- `stock_search/data_sources/yahoofinance.py` -> `YahooFinanceSource`.
- `stock_search/data_sources/stockanalysis/adapter.py` -> `StockAnalysisSource`.
- `stock_search/indicators.py` -> `StockIndicator` (consumes these adapters).

## Key takeaways per location

- `stock_search/data_sources/yahoofinance.py -> YahooFinanceSource` centralizes Yahoo info/history/ratings extraction and computes indicator-style values.
- `stock_search/data_sources/yahoofinance.py -> get_forward_pe_ntm` enforces fiscal-year-weighted NTM PE policy with FY1 fallback.
- `stock_search/data_sources/stockanalysis/adapter.py -> StockAnalysisSource` separates statistics, financials, and ETF holdings/sectors snapshots.
- `stock_search/data_sources/stockanalysis/adapter.py -> get_etf_holdings_snapshot` uses scrape-first, then web-search fallback.
- `stock_search/data_sources/stockanalysis/page_scrapers/` keeps StockAnalysis page-specific scraping logic grouped by source page.

## Project-specific conventions and rationale

- Keep provider files source-local: do not implement cross-source fallback here.
- Preserve ticker normalization semantics in `normalize_yahoo_ticker`.
- Preserve forward PE policy in Yahoo adapter:
  - Primary: NTM weighted blend (`epsCurrentYear` + `forwardEps`).
  - Secondary: FY1 (`price / forwardEps`).
- Preserve StockAnalysis ETF extraction order:
  - Parse holdings/sectors from page script first.
  - Fallback to constrained web-search extraction.

## Syntax relationship highlights (ast-grep-first)

- `stock_search/indicators.py -> StockIndicator.__init__` -> composes `YahooFinanceSource` and `StockAnalysisSource`.
- `stock_search/indicators.py -> _resolve_fallback_field` -> resolves fundamentals StockAnalysis-first then Yahoo fallback.
- `stock_search/portfolio.py -> _fetch_live_stats` -> directly uses `YahooFinanceSource` for live market and info fields.
- `stock_search/evaluation/evaluation.py -> build_inputs` -> uses `StockIndicator` (which depends on these sources).

## General approach (not rigid checklist)

- Add or adjust provider methods in the source module first, then confirm downstream field usage in `stock_search/indicators.py`.
- Prefer explicit `None` on missing/unreliable values; let orchestration layers apply fallback decisions.
- Keep return types stable for snapshots to avoid breakage in consumers.

## Validation commands

- Quick import check:
  - `uv run python -c "from stock_search.data_sources.yahoofinance import YahooFinanceSource; from stock_search.data_sources.stockanalysis import StockAnalysisSource; print('ok')"`
- Formatting/lint hook:
  - `/Users/teron/Projects/Agents-Config/.factory/hooks/formatter.sh`
