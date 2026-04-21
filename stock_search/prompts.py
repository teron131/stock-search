"""Store reusable prompts used across stock-search workflows."""

NEWS_ANALYSIS_PROMPT = """Summarize with concrete facts, numbers, and named entities. No meta-language. Exclude ads/boilerplate. Prefer facts over opinions.

Relevancy to {ticker}: high = primary subject; medium = indirect sector/competitors/macro; low = market noise or subjective opinions without new facts. High only if {ticker} is primary; market wraps default low unless {ticker} is a driver.

Sentiment toward {ticker}: bullish/ bearish if clearly positive/negative; neutral if mixed/unclear (insider selling neutral unless unusually large/illegal/clearly adverse). Subjective opinion defaults neutral unless objective facts clearly support a direction.

If {ticker} not mentioned: relevancy=low, sentiment=neutral, summary notes no relevant content.

Category: company_news, earnings, analyst_rating, industry_news, market_news, macro_economics, analysis, other.

{title}
{content}"""

PORTFOLIO_NEWS_SUMMARY_PROMPT = """Write a chaptered portfolio news summary from already-detailed article summaries.

Return structured fields only.

Goals:
- Summarize the summaries rather than restating every article.
- Use the held ticker order only to decide which ticker groups matter most.
- Keep the result concise, readable, and organized like a market recap with chapter headings.

Output shape:
- macros: 0 to 3 chapter blocks about genuine market or macro drivers.
- top_tickers: one entry for each ticker in TOP_POSITIONS, in the same priority order.
- each chapter:
  - headline: a headline-style segment title, not a taxonomy label.
  - paragraph: one compact summary paragraph.
  - tickers: subset of HELD_TICKERS directly relevant to that chapter, or [] for broad market macro chapters.
- each top_tickers entry:
  - ticker
  - chapters: 1 to 3 chapter blocks for that ticker.

Writing rules:
- Write like a short portfolio news summary, not a bullet digest and not a full article recap.
- Chapter headlines are just subparagraph headings, like segments in a spoken market recap.
- No timestamps.
- Prefer implications and what mattered yesterday over chronology.
- Avoid lists of side facts, repeated names, repeated dates, and article-by-article retelling.
- Keep numbers only when they materially change the takeaway.
- Do not mention costs, shares, position sizes, weight rankings, or concentration percentages.
- Do not use generic headings like Theme, Takeaway, Setup, Weight, Backdrop, Cross-ticker, Company update, or News theme.
- For macros, include only genuine macro or market-wide drivers such as rates, inflation, Fed, tariffs, geopolitics, regulation, FX, oil, or broad risk sentiment.
- Industry-specific or company-specific stories do not belong in macros.
- If there is no real macro driver in the input, return macros=[].
- A macro chapter is still valid even if no held ticker is named directly; in that case use tickers=[].
- For each ticker, synthesize the relevant article summaries into a few chapter paragraphs instead of paraphrasing one article at a time.
- Merge overlapping articles into one chapter when they are about the same development.
- If a top ticker has thin coverage, still provide one restrained chapter that says coverage is thin.

HELD_TICKERS
{held_tickers_json}

TOP_POSITIONS
{top_positions_json}

MERGED_ARTICLE_SUMMARIES
{news_items_json}"""

MOAT_DEFINITION = """Moat (0-10): replaceability under constraints.
How hard is it for a capable competitor (or customer) to replicate, displace, or route around this in the real world?
Barriers include switching costs / lock-in; regulatory + security + procurement barriers; integration depth + operational
workflow embedding; ecosystem/tooling gravity; and unique supply-chain/physics constraints (ASML-style).
Note: commodity does not always mean 0; consider rarity or supply constraints."""

QUALITY_DEFINITION = """Quality (0-10): ability to turn advantage into durable economics.
Profitability belongs here along with resilience. Consider margins / FCF durability across cycles,
pricing power & customer retention, operating discipline, and delivery reliability."""

RESEARCH_DEFINITION = f"Evaluate the company's Moat and Quality on a 0-10 scale.\n{MOAT_DEFINITION}\n{QUALITY_DEFINITION}"

FUTURE_OUTLOOK_DEFINITION = """Future outlook (0-10): based on foreseeable company guidance and credible near-term signals.
Score how strong the forward setup looks over ~12 months. Estimate bull/bear probabilities (0-1) for up/down in 12 months.
Reason should be a short bullet list."""
