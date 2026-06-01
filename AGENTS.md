# AGENTS.md (stock-news / stock-search)

This file guides agentic coding assistants working in this repo.

## Repo Snapshot

- **Package Manager**: `pnpm`.
- **Backend**: TypeScript API in `src/stock-search/api/`, served locally by `src/node.ts`.
- **UI**: Next frontend in `ui/`.
- **CLI**: TypeScript CLI in `src/stock-search/cli.ts`, run with `pnpm run cli`.
- **MCP**: `src/stock-search/mcp/` exposes the broader tool surface.
- **Data**: `BackendStore` implementations. Local default is SQLite at `data/stock_search.db`; Convex is optional via env.

## Runtime Boundaries

- Portfolio routes use `scope`; standalone ticker routes, CLI `stocks`, and MCP `get_stock_stats` use `source`.
- External MCP `get_portfolio` defaults to `scope=portfolio_live`; REST callers should pass `/portfolio?scope=portfolio_live` when they need a current portfolio snapshot.
- `source=auto`: use fresh cache, serve usable stale slow families while queueing refresh, and refresh inline when required.
- `source=live`: force inline provider refresh; fail instead of silently falling back when live data is unavailable.
- `source=cache`: read the stored row only.
- Scope/priority logic is portfolio-level only. Do not reuse it for ticker-level APIs.
- Keep ticker endpoints usable independently of portfolio scope for external API consumers.

## Data Model

Keep these concepts separate:

- **Portfolio state**: positions, quantities, strategies.
- **Stock indicators**: cacheable market data, metadata, fundamentals, ratings, ETF lookthrough fields.
- **Evaluation**: derived scoring, research, and qualitative payloads.
- **News and sectors**: cached domain payloads with their own refresh paths.

Do not reintroduce hand-maintained duplicate transport contracts. Backend schema changes should flow through the API/MCP surface and generated or shared types where practical.

## Data Sources

- Prefer free public web-source values for fundamental statistics, with cache-first behavior and resilient fallback.
- Current provider families include StockAnalysis, Finviz, Yahoo-backed market data, news providers, and LLM-backed extraction where the code already uses it.
- For `revenue_growth` and `eps_growth`, prefer period-aligned public-source values. If a fallback source cannot produce a trustworthy period-aligned value, return `null` and let higher-quality fallback resolution decide.
- Keep provider-specific parsing in the data-source modules, not in API routes or UI code.

## CLI

Use the curated CLI for agent-facing stock analysis:

```bash
pnpm run cli help
pnpm run cli stocks NVDA
pnpm run cli stocks NVDA MSFT
pnpm run cli stocks NVDA,MSFT --source cache
pnpm run cli sectors
pnpm run cli news NVDA
pnpm run cli evaluate NVDA
```

`stocks` is intentionally plural. It accepts separate tickers, comma-separated tickers, or both. JSON output is compact by default; pass `--pretty` for indented output.

The external skill wrapper lives in `/Users/teron/Projects/agents-config/skills/stock-search` and should remain a thin wrapper over this repo. Do not vendor app code into the skill.

## Commands

- Install dependencies: `pnpm install`
- Run API + UI: `pnpm run dev`
- Run backend only: `pnpm run server:start`
- Run MCP server: `pnpm run mcp:start`
- Typecheck backend/app code: `pnpm run server:typecheck`
- Build broader app: `pnpm run build`

For CLI or skill-surface changes, prefer:

```bash
pnpm exec biome check src/stock-search/cli.ts README.md
pnpm run server:typecheck
pnpm run cli help
pnpm --silent run cli stocks NVDA --source cache
```

## Configuration

See `.env.example` and `src/stock-search/api/config.ts`.

- `DATA_STORE_BACKEND`: `sqlite` or `convex`.
- `DATA_SQLITE_PATH`: local SQLite path override.
- `CONVEX_URL`, `CONVEX_DEPLOY_KEY`, `CONVEX_AUDIENCE`, `CONVEX_SYNC_ENABLED`: Convex runtime.
- `AUTH_ENABLED`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `ALLOWED_EMAIL`: auth controls.
- `LLM_API_KEY`, `LLM_BASE_URL`, `FAST_LLM`, `QUALITY_LLM`, `GEMINI_API_KEY`: model clients.
- `NEWS_API_KEY`, `NEWSDATA_API_KEY`: news providers.

## Code Conventions

- Match current TypeScript module boundaries; do not add Python/uv-era scripts unless explicitly requested.
- API routes adapt requests and responses; domain behavior belongs in `portfolio`, `stats-resolver`, `data-sources`, `models`, `news`, or `evaluation`.
- Keep provider-specific request and parsing logic beside the provider.
- Preserve `source` semantics for ticker flows and `scope` semantics for portfolio flows.
- Prefer explicit names and one term per concept. Avoid route-shaped CLI names when the curated CLI command exists.
- Keep skill docs and wrappers operational and short: command surface, when to use it, verification. No vendored app source.
