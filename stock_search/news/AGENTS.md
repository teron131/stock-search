# AGENTS.md (stock_search/news)

This guide is for changes inside `stock_search/news/`.

## Scope

- Multi-provider news discovery and normalization.
- URL/content analysis pipeline and enrichment.
- Provider failover and post-fetch filtering/sorting.

## High-signal locations

- `stock_search/news/orchestrator.py` -> `get_news` orchestration and enrichment.
- `stock_search/news/providers/exa.py` -> Exa provider adapter.
- `stock_search/news/providers/newsapi.py` -> NewsAPI adapter.
- `stock_search/news/providers/newsdata.py` -> NewsData adapter.
- `stock_search/news/providers/yahoofinance.py` -> Yahoo Finance adapter.
- `stock_search/news/providers/massive.py` -> Massive provider adapter.

## Key takeaways per location

- `stock_search/news/orchestrator.py -> get_news` executes provider fan-in, dedupe, LLM analysis, domain balancing, filtering, and final sorting.
- `stock_search/news/orchestrator.py -> _dedupe_news` relies on normalized URL/title key to avoid duplicate stories.
- `stock_search/news/orchestrator.py -> _analyze_news` uses `webloader` + structured LLM output and tolerates fetch/analysis failures.
- Provider modules return `NewsArticle` items with best-effort metadata and leave cross-provider policy to `orchestrator.py`.

## Project-specific conventions and rationale

- Preserve graceful degradation: one provider failure must not collapse the full news result.
- Preserve fallback summary semantics (`[TRUNCATED]`, `[FAILED TO FETCH]`) because downstream filtering depends on them.
- Keep HTTP calls timeout-aware (`httpx`) and avoid logging secrets/API keys.
- Keep output shape stable for consumers expecting `NewsArticle` fields.

## Syntax relationship highlights (ast-grep-first)

- `stock_search/news/__init__.py` re-exports `get_news` and individual provider functions.
- `stock_search/news/orchestrator.py -> get_news` -> calls provider functions:
  - `get_news_newsdata`
  - `get_news_massive`
  - `get_news_exa`
  - `get_news_yfinance`
  - `get_news_newsapi`
- `stock_search/news/orchestrator.py -> _analyze_news` -> calls `llm_harness.tools.webloader` and `ChatOpenAI(...).with_structured_output(NewsAnalysis)` through the Vercel AI Gateway-compatible client wrapper.

## General approach (not rigid checklist)

- Add provider-specific fetch/parsing logic only in `providers/`.
- Keep orchestration policies (dedupe, filtering, sorting, balancing) centralized in `orchestrator.py`.
- If changing filtering rules, preserve deterministic sort order by `days_ago` then `relevancy`.

## Validation commands

- Existing smoke script:
  - `uv run python test_news.py`
- Formatting/lint hook:
  - `/Users/teron/Projects/Agents-Config/.factory/hooks/formatter.sh`
