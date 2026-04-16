# Stock News / Stock Search

**Static Demo**: https://teron131.github.io/stock-search

A single-user stock analysis app that prioritizes free data, resilient fallbacks, and simple storage.

## Core Methodology

- **Separation of concerns**: Portfolio management, ticker-level stat resolution, and evaluation logic are isolated so each layer can evolve independently.
- **Source-first indicators**: Data source adapters (`yfinance`, StockAnalysis) are treated as causes; indicator orchestration is the effect layer that unifies fields and fills gaps.
- **Cache-aware by design**: Missing fields resolve to `None` or cached values when freshness rules allow, reducing noisy failures and unnecessary refetches.
- **Batch over piecemeal**: When a provider call naturally returns grouped data, the app consumes it as a batch to reduce duplicate requests.

## Stats Resolution Flow

```mermaid
flowchart TD
    accTitle: Family-based stats resolution flow
    accDescr: Shows how cache-only, auto, and live requests resolve ticker stats through persisted cache, in-memory family cache, inline refresh, and background refresh.
    Request["Portfolio or standalone stats request"] --> Mode{"Mode / scope?"}
    Mode -->|`priority` or `cache`| Persisted["Read persisted stats row"]
    Mode -->|`auto`, `portfolio_live`, `all`, or `live`| Resolver["Family-based stats resolver"]

    Resolver --> Persisted
    Persisted --> L1["Overlay fresher in-memory family cache"]
    L1 --> Family{"Family fresh?"}

    Family -->|Yes| ServeFresh["Use cached family"]
    Family -->|No, `market_data`| InlineFast["Inline refresh realtime market data"]
    Family -->|No, slow family stale| StaleServe["Serve stale family and queue background refresh"]
    Family -->|No, slow family missing| InlineSlow["Inline fetch missing slow family"]

    InlineFast --> Provider["Yahoo / StockAnalysis provider fetch"]
    InlineSlow --> Provider
    Provider --> Batch["If one page returns extra stats, persist those too"]
    Batch --> WriteThrough["Write through L1 cache and persisted store"]

    ServeFresh --> Merge["Merge family results into one ticker row"]
    StaleServe --> Merge
    WriteThrough --> Merge

    Merge --> Payload["Build portfolio rows or standalone response"]
    Payload --> Eval["Apply evaluation, labels, and ETF lookthrough tables"]
```

## Module Overview

- **`stock_search/data_sources/`**
  - Provider-specific fetchers and parsers.
  - Keeps external API/scraping variability out of business logic.

- **`stock_search/indicators.py`**
  - Unified indicator resolver across sources.
  - Centralizes field-level precedence and cache fallback so callers stay source-agnostic.

- **`stock_search/evaluation/`**
  - Scoring, normalization, and ranking logic.
  - Keeps decision logic deterministic and independent from raw fetching.

- **`stock_search/api/`**
  - HTTP routes for portfolio flows, standalone ticker reads, and utility endpoints.
  - Clean boundary between UI contract and internal data orchestration.

- **`stock_search/models/`**
  - Shared schemas, labels/constants, and storage interfaces.
  - One canonical model layer for API, evaluation, and persistence code.

- **`stock_search/models/convex/`**
  - Convex adapter, store facade, and import tooling.
  - Encapsulates cloud persistence details behind typed, app-level operations.

## Data Sources

- **Yahoo Finance (`yfinance`)**
  - Fast quote/history/options/ratings-oriented data access.
  - Broad free coverage and strong baseline for live market fields.

- **StockAnalysis (web extraction)**
  - Statistics/financial statement aligned fields and ETF holdings context.
  - Better alignment for valuation/fundamental fields where API feeds can diverge.

- **Fallback policy**
  - Prefer higher-quality source per field group, then cache, then fallback provider.
  - Improves consistency while remaining resilient during source failures.

## Convex

- Primary persistence backend for stocks, portfolio state, news, and metadata.
- Gives a single cloud-backed source of truth and supports realtime-friendly integration.

Current Convex function namespaces are intentionally singular to match the one-portfolio app model:

- `portfolio:get`, `portfolio:set`
- `stock:list`, `stock:get`, `stock:replaceAll`
- `news:list`, `news:replaceAll`
- `meta_versions:get`, `meta_versions:set`

## FastMCP

A minimal FastMCP proxy server is available for the existing FastAPI backend. It converts the main backend endpoints into MCP tools without duplicating business logic.

Run it with:

```bash
uv run python -m stock_search.mcp
```

The MCP server currently exposes tools for:

- portfolio reads and position updates
- standalone stock stats
- stored eval and stock maps
- realtime config, stock news, and ticker evaluation
