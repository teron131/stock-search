# AGENTS.md (stock_search/news)

This guide is for changes inside `stock_search/news/`.

## Scope

- News discovery, article retrieval, and optional LLM enrichment.
- Provider failover for headlines/articles.

Representative files:

- `stock_search/news/analysis.py`
- `stock_search/news/yahoofinance.py`
- `stock_search/news/newsapi.py`
- `stock_search/news/exa.py`
- `stock_search/news/newsdata.py`

## Responsibilities

- Return consistent article/news structures across providers.
- Implement provider fallback and graceful degradation.
- Keep optional enrichment paths isolated from baseline fetch logic.

## Invariants

- Preserve provider fallback behavior (do not hard-fail when one provider fails).
- Do not log secrets or raw API keys.
- Keep external calls timeout-aware and failure-tolerant.
- Keep model names unchanged unless repo references require coordinated updates.

## Safe Change Pattern

1. Add provider-specific extraction in the provider module.
2. Keep shared output schema stable.
3. Ensure orchestrator-level fallback still executes on partial provider failures.

## Validation

- Existing smoke script:
  - `uv run python test_news.py`
- Format/lint:
  - `/Users/teron/Projects/Agents-Config/.factory/hooks/formatter.sh`
