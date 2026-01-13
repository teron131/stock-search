# LLM Prompts and Definitions

# evaluation.py
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

# news/analysis.py
NEWS_ANALYSIS_PROMPT = """Summarize with concrete facts, numbers, and named entities. No meta-language. Exclude ads/boilerplate. Prefer facts over opinions.

Relevancy to {ticker}: high = primary subject; medium = indirect sector/competitors/macro; low = market noise or subjective opinions without new facts. High only if {ticker} is primary; market wraps default low unless {ticker} is a driver.

Sentiment toward {ticker}: bullish/ bearish if clearly positive/negative; neutral if mixed/unclear (insider selling neutral unless unusually large/illegal/clearly adverse). Subjective opinion defaults neutral unless objective facts clearly support a direction.

If {ticker} not mentioned: relevancy=low, sentiment=neutral, summary notes no relevant content.

Category: company_news, earnings, analyst_rating, industry_news, market_news, macro_economics, analysis, other.

{title}
{content}"""

# etf.py
ETF_SYSTEM_PROMPT = """Find the top ETF holdings and sector weightings from the provided web content. For holdings, extract the ticker, full company name, and weight percentage. For sectors, extract the sector name and weight percentage. Only include data you can clearly identify from the content. Standardize sectors to the list: Technology, Materials, Financials, Healthcare, Industrials, Real Estate, Energy, Utilities, Consumer Discretionary, Communication Services, Consumer Staples. https://stockanalysis.com/etf/[TICKER]/holdings/ where [TICKER] is the ETF ticker."""
