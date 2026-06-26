---
name: stock-search
description: Use for stock analysis under the local opinionated Stock Search framework through the installed stock-search CLI.
---

# Stock Search

Use this for stock analysis through the local Stock Search framework.

## Quick Start

Use the installed CLI for stock analysis:

```bash
stock-search help
```

The installed command loads the user-level Stock Search environment copy and runs the repo's TypeScript CLI behind the scenes.

## Commands

- `help`: list command syntax and notes
- `stocks TICKER... [--source auto|live|cache] [--pretty]`: return compact scalar stock stats for one or many tickers
- `sectors [--pretty]`: return the current sector stats snapshot
- `news TICKER [--mode raw-fast|analyzed-slow] [--max-results N] [--pretty]`: return recent ticker news
- `evaluate TICKER [--pretty]`: return the ticker evaluation payload

Examples:

```bash
stock-search help
stock-search stocks NVDA GOOGL
stock-search stocks NVDA,GOOGL --source live --pretty
stock-search sectors
stock-search news NVDA
stock-search news NVDA --mode raw-fast --max-results 5 --pretty
stock-search news NVDA --mode analyzed-slow --max-results 5 --pretty
stock-search evaluate NVDA
```

`stocks` is intentionally plural. It accepts one ticker, multiple tickers, or a comma-separated ticker list.
For machine parsing, prefer `stock-search ...`; plain `pnpm run` prints package-manager lines before output.

## When To Use What

- Use `stocks` for quick numeric comparison. It strips nested detail and returns only compact scalar fields.
- Use `news --mode raw-fast` when the task needs recent company-specific article candidates for one ticker. This is the default mode.
- For portfolio news refresh/update work, use raw portfolio evidence, write the summaries yourself, then save them back through the DB tools.
- Use `news --mode analyzed-slow` only for one-off ticker-level relevance, category, sentiment, and summaries when LLM latency/cost is acceptable.
- Use `evaluate` when the task needs the app's full ticker evaluation payload.
- Use `sectors` when the task needs the current StockAnalysis sector snapshot.
- Do not call raw backend route-shaped tool names from this skill. The CLI surface is intentionally smaller.

## Boundary

Keep these concepts separate:

- Backend `/stocks`: raw persisted stock indicator map, too noisy for CLI.
- Backend `/stock/:ticker/stats`: full standalone app row for one ticker.
- CLI `stocks`: compact multi-ticker stats view over `/stock/:ticker/stats`, with nested detail stripped.
- CLI `news`: ticker news only. `raw-fast` fans out through configured providers and does not run LLM analysis; `analyzed-slow` adds LLM labels and summaries.
- News providers: configured primary providers, Yahoo Finance fallback, and optional raw-fast shortfall filling.
- Portfolio news: MCP tools own raw bundles, persistence, and portfolio-level summaries (`get_portfolio_news_raw_fast`, `get_portfolio_news`, `save_portfolio_news`, `get_portfolio_news_summary`, `save_portfolio_news_summary`, `summarize_portfolio_news`) when that MCP surface is available.

## Portfolio News DB Workflow

When the task is portfolio news refresh/update, prefer the MCP portfolio news tools over ticker CLI news:

1. Fetch raw evidence with `get_portfolio_news_raw_fast`, using bounded `n_days` and `max_results_per_ticker`.
2. Read the raw articles and write compact external-agent ticker summaries.
3. Persist ticker summaries with `save_portfolio_news`. Use `key` only for a non-default portfolio or news scope.
4. Write the portfolio-level synthesis and persist it with `save_portfolio_news_summary`; use `summarize_portfolio_news` only when its structured output helps.
5. Verify persistence with `get_portfolio_news` and `get_portfolio_news_summary`.

Do not make `analyzed-slow` the default portfolio update path. Portfolio refresh expects raw evidence plus agent judgment saved to the DB.

If the MCP tools are not exposed, use CLI `news --mode raw-fast` only for evidence gathering. DB update needs the MCP/app tool surface.

Portfolio data comes from the app repo's configured private `BackendStore`: cloud mode uses Cloudflare D1, while local mode uses SQLite. The static demo JSON is only for the browser demo route and is not used by this skill.

For behavior changes, edit the app repo directly:

```bash
cd stock-search
```

Do not vendor app source into this skill. Keep this folder as operating notes for the installed CLI.
