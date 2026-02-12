# AGENTS.md (stock_search/data_sources)

This guide is for changes inside `stock_search/data_sources/`.

## Scope

- Source-local adapters only.
- No cross-provider orchestration policy in this folder.

Primary files:

- `stock_search/data_sources/yahoofinance.py` -> class `YahooFinanceSource`
- `stock_search/data_sources/stockanalysis.py` -> class `StockAnalysisSource`

## Responsibilities

- Fetch and normalize provider-native snapshots.
- Keep methods resilient and return `None`/empty snapshots on recoverable failures.
- Expose fields consumed by `stock_search.indicators.StockIndicator`.

## Invariants

- Cross-source precedence belongs in `stock_search/indicators.py`, not here.
- Preserve `normalize_yahoo_ticker` behavior for symbol normalization.
- Preserve forward P/E policy in Yahoo adapter (`get_forward_pe_ntm`):
  - NTM FY0/FY1 blend first
  - FY1 fallback second
- Keep StockAnalysis ETF extraction flow:
  - scrape/page parse first
  - web-search fallback second

## Safe Change Pattern

1. Add or refine a provider method.
2. Keep return type stable (especially for snapshot dataclasses/models).
3. Update callers only if a field contract must change.

## Validation

- Quick import/runtime check:
  - `uv run python -c "from stock_search.data_sources.yahoofinance import YahooFinanceSource; from stock_search.data_sources.stockanalysis import StockAnalysisSource; print('ok')"`
- Format/lint:
  - `/Users/teron/Projects/Agents-Config/.factory/hooks/formatter.sh`
