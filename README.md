# Stock News / Stock Search

Many “premium” finance APIs are expensive. This project is designed to prefer **free/low-cost sources first**, and then **fall back** to other providers when data is missing, blocked, or unreliable.

## Data Providers (Fallback Strategy)

This repo uses a layered approach per feature. If a higher-priority source fails (rate limits, missing fields, blocked pages), the next one is tried.

- **Broker / portfolio data (optional)**
  - Primary: IBKR Gateway
    - https://www.interactivebrokers.com/en/trading/ibgateway-latest.php
    - https://github.com/ib-api-reloaded/ib_async
- **Quotes, basic fundamentals, indicators**
  - Primary: Yahoo Finance (via `yfinance`)
  - Fallback: Yahoo Finance web scraping (via Selenium) when the API view is incomplete/inaccurate
- **News discovery (headline + URL)**
  - Primary: Yahoo Finance search (via `yfinance.Search`)
  - Fallback: NewsAPI (requires `NEWS_API_KEY`)
  - Optional fallback: “AI web search” (OpenRouter web plugin) for sources that aren’t covered well by standard APIs
- **Article text extraction (URL → clean text)**
  - Primary: Docling web loader (clean markdown from a URL)
  - Fallback: mark as unavailable (some websites block automated access)
- **LLM enrichment (optional)**
  - Structured extraction into `NewsAnalysis` (summary, relevancy, category, sentiment)
  - You can disable these add-ons if you prefer to read/analyze the articles yourself to minimize cost.

## Configuration

Common environment variables:

- `OPENROUTER_API_KEY`: required for any LLM or “AI web search” features
- `NEWS_API_KEY`: required only if you enable NewsAPI fallback
- `FAST_LLM`: optional, defaults to `google/gemini-3-flash-preview`
