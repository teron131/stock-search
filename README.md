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
    accTitle: Family-based stats workflow
    accDescr: Shows how portfolio and standalone requests resolve stats through mode selection, layered caches, family freshness checks, provider refreshes, and final payload assembly.

    Request["Portfolio or standalone request"]
    Request --> Mode{"Scope / source"}

    Mode -->|`priority` or `cache`| CacheMode["Cache-only path"]
    Mode -->|`auto`, `portfolio_live`, `all`| AutoMode["Auto path"]
    Mode -->|`live`| LiveMode["Live-only path"]

    CacheMode --> Load["Read persisted ticker row"]
    AutoMode --> Load
    LiveMode --> Load

    Load --> Overlay["Overlay fresher in-memory family cache"]
    Overlay --> Decision{"Family state?"}

    Decision -->|Fresh| Fresh["Use cached family"]
    Decision -->|Slow family stale in `auto`| Stale["Serve stale family"]
    Stale -.-> Queue["Queue background refresh"]
    Decision -->|Slow family missing| InlineSlow["Inline scrape/fetch"]
    Decision -->|Market family expired| InlineFast["Inline market refresh"]
    Decision -->|`live` mode| ForceLive["Force inline refresh"]

    InlineSlow --> Provider["Provider fetch"]
    InlineFast --> Provider
    ForceLive --> Provider

    Provider --> Piggyback["Reuse grouped page results"]
    Piggyback --> Persist["Write through memory + persisted cache"]

    Fresh --> Merge["Merge family results into one ticker row"]
    Stale --> Merge
    Persist --> Merge

    Merge --> Standalone["Standalone ticker response"]
    Merge --> Portfolio["Portfolio rows"]
    Portfolio --> Enrich["Apply labels, eval, and ETF lookthrough tables"]
```

```mermaid
flowchart TD
    accTitle: Source priority by stat family
    accDescr: Shows which provider is preferred for each stat family and where cache fallback fits.

    subgraph YahooLed["Yahoo-led families"]
        direction LR
        Market["Realtime market data"] --> MarketFlow["Yahoo first -> cache fallback"]
        Snapshot["Market snapshot"] --> SnapshotFlow["Yahoo first -> cache fallback"]
        Ratings["Ratings"] --> RatingsFlow["Yahoo first -> fresh cache second"]
    end

    subgraph ScrapeLed["Scrape-led families"]
        direction LR
        Stats["Statistics"] --> StatsFlow["StockAnalysis scrape -> fresh cache -> Yahoo fallback"]
        Financials["Financials"] --> FinancialsFlow["StockAnalysis scrape -> fresh cache -> Yahoo fallback"]
    end
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

## Local SQLite

- Local fallback and non-Convex mode now use `data/stock_search.db`.
- `generate_static_data.py` writes sample data to `data/sample_stock_search.db` by default and can refresh the main SQLite store with `--prod`.

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

## CLI

The same MCP-backed tool set is also available as a local CLI.

Run it with:

```bash
uv run stock-search list-tools
uv run stock-search get-portfolio --scope priority
uv run stock-search get-stock-stats NVDA --source cache
uv run stock-search evaluate-stock NVDA
```

The CLI discovers the MCP tools at runtime and maps them to kebab-case subcommands, so it stays aligned with the MCP surface.
