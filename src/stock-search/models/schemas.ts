/** Shared stock-search data schemas. */

import { z } from "zod";

import { getFieldDescription } from "./field-definitions.js";
import { INDUSTRY_LABELS } from "./labels.js";

const relevancyValues = ["high", "medium", "low"] as const;
const summaryRelevancyValues = ["high", "medium"] as const;
const sentimentValues = ["bullish", "neutral", "bearish"] as const;
const newsCategoryValues = [
  "macro_economics",
  "industry_news",
  "market_news",
  "company_news",
  "earnings",
  "analyst_rating",
  "analysis",
  "other",
] as const;
const tickerSummaryCategoryValues = [
  ...newsCategoryValues,
  "rates",
  "inflation",
  "fed_policy",
  "geopolitics",
  "regulation",
  "fx",
  "oil_energy",
  "ai_capex",
  "data_center_power",
  "supply_chain",
  "demand",
  "pricing",
  "margins",
  "valuation",
  "capital_allocation",
  "guidance",
] as const;
const tickerNewsSummaryLabelExamples = [
  "trump",
  "election",
  "tariff",
  "china",
  "taiwan",
  "export_controls",
  "war",
  "middle_east",
  "ukraine",
  "oil_price",
  "natural_gas",
  "earnings",
  "guidance",
  "cpi",
  "jobs_report",
  "fed",
  "rates",
  "dollar",
  "market_liquidity",
  "credit_spreads",
  "ai_capex",
  "hbm",
  "memory",
  "cloud_capex",
  "data_center_power",
  "regulation",
  "antitrust",
  "lawsuit",
  "m_and_a",
  "buyback",
  "dividend",
  "supply_chain",
  "demand",
  "pricing",
  "margins",
  "inventory",
  "product_cycle",
] as const;

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

const ETF_MARKET_CAP_FIELDS = ["market_cap", "fx"] as const;
const ETF_PROXY_METADATA_FIELDS = [
  "proxied_stat_fields",
  "proxied_stat_coverage",
  "stats_proxy_source",
] as const;

function isEtfIndicatorRow(row: Record<string, unknown>): boolean {
  return (
    String(row.quote_type ?? row.equity_type ?? "")
      .trim()
      .toUpperCase() === "ETF"
  );
}

function normalizeEtfHoldings(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  const holdings: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const ticker = typeof row.ticker === "string" ? row.ticker.trim().toUpperCase() : "";
    const weight = Number(row.weight);
    if (!ticker || !Number.isFinite(weight) || weight <= 0) {
      continue;
    }
    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : null;
    holdings.push({ ticker, name, weight });
  }
  return holdings;
}

function clearEtfProxyMetadata(indicators: Record<string, unknown>): void {
  for (const field of ETF_PROXY_METADATA_FIELDS) {
    delete indicators[field];
  }
}

/** Normalize indicator payloads before they are cached, persisted, or rendered. */
export function normalizeStockIndicators(value: unknown): Record<string, unknown> {
  const indicators =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  if (isEtfIndicatorRow(indicators)) {
    for (const field of ETF_MARKET_CAP_FIELDS) {
      indicators[field] = null;
    }
  } else {
    clearEtfProxyMetadata(indicators);
  }
  if (Array.isArray(indicators.etf_holdings)) {
    indicators.etf_holdings = normalizeEtfHoldings(indicators.etf_holdings);
  }
  return indicators;
}

export const StockIndicatorsSchema = z
  .record(z.string(), z.unknown())
  .transform(normalizeStockIndicators)
  .describe(
    "Flat stock indicator payload after normalizing fields that should not be persisted for ETFs.",
  );

/** Break down position notional by source so ETF lookthrough stays optional. */
export class Notional {
  from_stocks: number;
  from_etf: number;
  from_options: number;

  constructor(input: Partial<Notional> = {}) {
    this.from_stocks = finiteNumber(input.from_stocks);
    this.from_etf = finiteNumber(input.from_etf);
    this.from_options = finiteNumber(input.from_options);
  }

  get total(): number {
    return this.from_stocks + this.from_etf + this.from_options;
  }

  addFromStocks(value: number): this {
    this.from_stocks += finiteNumber(value);
    return this;
  }

  addFromEtf(value: number): this {
    this.from_etf += finiteNumber(value);
    return this;
  }

  addFromOptions(value: number): this {
    this.from_options += finiteNumber(value);
    return this;
  }

  rounded(decimals = 2): Notional {
    const factor = 10 ** decimals;
    return new Notional({
      from_stocks: Math.round(this.from_stocks * factor) / factor,
      from_etf: Math.round(this.from_etf * factor) / factor,
      from_options: Math.round(this.from_options * factor) / factor,
    });
  }
}

export const NotionalSchema = z
  .object({
    from_stocks: z
      .number()
      .default(0)
      .describe("Notional exposure contributed by directly held stocks."),
    from_etf: z
      .number()
      .default(0)
      .describe("Notional exposure contributed by ETF look-through holdings."),
    from_options: z
      .number()
      .default(0)
      .describe("Notional exposure contributed by option positions."),
  })
  .describe("Position notional exposure broken down by source.");

export const NewsAnalysisModelSchema = z
  .object({
    summary: z
      .string()
      .describe(
        "Concise factual summary about the requested ticker/company entity only. Include concrete numbers and named entities from the final article text. If the article is mainly about another company and contains no material requested-entity facts, say no relevant ticker-specific content is present instead of summarizing the other company.",
      ),
    relevancy: z
      .enum(relevancyValues)
      .describe(
        "Relevance to the requested ticker/company entity after resolving ticker, company name, parent company, and obvious public brand names. high: requested entity is the main subject with concrete investment-relevant facts in the final article text. medium: requested entity is materially discussed in a multi-company, peer, sector, or macro story with a real impact path. low: requested entity is incidental, appears only in a comparison/list/watchlist/snippet, or the final article is mainly about another company.",
      ),
    category: z
      .enum(newsCategoryValues)
      .describe(
        "Primary article type. company_news for company operations/product/customer/regulatory/M&A/capital allocation updates; earnings for results/guidance/financial metrics; analyst_rating for ratings, price targets, or analyst notes; industry_news for sector developments; market_news for broad market moves; macro_economics for rates, inflation, Fed, tariffs, geopolitics, FX, oil, or broad economic drivers; analysis for investment thesis/opinion backed by facts; other only when no category fits.",
      ),
    sentiment: z
      .enum(sentimentValues)
      .describe(
        "Sentiment toward the requested ticker/company entity. bullish when article facts are clearly positive for that entity or stock, bearish when clearly negative, neutral when mixed, unclear, only informational, about another company, or based mainly on subjective opinion.",
      ),
  })
  .describe("[STRUCTURED OUTPUTS] Ticker-specific article analysis returned by the news analyzer.");

export const NewsAnalysisSchema = z
  .object({
    summary: z.string().default("").describe("Factual ticker-specific article summary."),
    relevancy: z
      .enum(relevancyValues)
      .default("low")
      .describe("Ticker relevance classification: high, medium, or low."),
    category: z
      .enum(newsCategoryValues)
      .default("other")
      .describe("Primary news category assigned to the article."),
    sentiment: z
      .enum(sentimentValues)
      .default("neutral")
      .describe("Directional sentiment toward the requested ticker."),
  })
  .describe("Normalized article analysis fields.");

export const ScoredReasonSchema = z
  .object({
    score: z
      .number()
      .nullable()
      .optional()
      .describe("Optional numeric score for the evaluated dimension."),
    reasons: z.array(z.string()).default([]).describe("Short reasons supporting the score."),
  })
  .describe("Score with supporting reasons.");

export const MetricsEvaluationSchema = z
  .object({
    market_cap_score: z
      .number()
      .nullable()
      .optional()
      .describe(getFieldDescription("market_cap_score")),
    valuation_score: z
      .number()
      .nullable()
      .optional()
      .describe(getFieldDescription("valuation_score")),
    upside_score: z.number().nullable().optional().describe(getFieldDescription("upside_score")),
  })
  .describe("Quantitative metrics evaluation fields.");

export const ResearchEvaluationSchema = z
  .object({
    moat_score: ScoredReasonSchema.nullable()
      .optional()
      .describe(getFieldDescription("moat_score")),
    quality_score: ScoredReasonSchema.nullable()
      .optional()
      .describe(getFieldDescription("quality_score")),
  })
  .describe("Research-backed qualitative evaluation fields.");

export const FutureOutlookSchema = ScoredReasonSchema.describe(
  "Forward-looking upside score with supporting reasons.",
);

export const EvaluationSchema = MetricsEvaluationSchema.merge(ResearchEvaluationSchema)
  .merge(FutureOutlookSchema)
  .describe("Complete ticker evaluation payload.");

export const TickerLabelsSchema = z
  .object({
    labels: z
      .array(z.string())
      .default([])
      .describe(
        "Industry labels chosen from the allowed taxonomy only, ordered by economic importance.",
      )
      .superRefine((labels, ctx) => {
        const invalidLabels = labels.filter((label) => !INDUSTRY_LABELS.includes(label));
        if (invalidLabels.length > 0) {
          ctx.addIssue({
            code: "custom",
            message: `labels must come from INDUSTRY_LABELS. Invalid: ${invalidLabels.join(", ")}`,
          });
        }
      }),
  })
  .describe("[STRUCTURED OUTPUTS] Industry label assignment for one ticker.");

export const NewsMetadataSchema = z
  .object({
    provider: z
      .string()
      .nullable()
      .optional()
      .describe("Provider adapter that returned the article."),
    source_domain: z.string().nullable().optional().describe("Normalized source website domain."),
    published_at: z
      .string()
      .nullable()
      .optional()
      .describe("Provider publication timestamp when available."),
    fetched_at: z
      .string()
      .nullable()
      .optional()
      .describe("Timestamp when the article was fetched into the local cache."),
  })
  .describe("Provider and freshness metadata for a news article.");

export const NewsArticleSchema = NewsAnalysisSchema.extend({
  url: z.string().describe("Canonical or provider article URL."),
  title: z.string().nullable().optional().describe("Article headline."),
  content_excerpt: z
    .string()
    .nullable()
    .optional()
    .describe("Capped excerpt from the webloaded article content when available."),
  date: z
    .string()
    .nullable()
    .optional()
    .describe("Human-readable or provider-formatted publication date."),
  days_ago: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Integer age of the article in days when known."),
  metadata: NewsMetadataSchema.nullable()
    .optional()
    .describe("Provider and freshness metadata for the article."),
}).describe("Normalized news article with analysis fields.");

export const PortfolioNewsChapterSchema = z
  .object({
    headline: z.string().describe("Headline-style chapter title."),
    paragraph: z.string().describe("Compact summary paragraph for the chapter."),
    tickers: z
      .array(z.string())
      .default([])
      .describe("Held tickers directly related to this chapter."),
  })
  .describe("One chapter in a portfolio news summary.");

const PortfolioNewsChapterModelSchema = z
  .object({
    headline: z
      .string()
      .describe(
        "Short headline-style segment title. Use a concrete takeaway, not a generic taxonomy label.",
      ),
    paragraph: z
      .string()
      .describe(
        "One compact paragraph that synthesizes the relevant article summaries and explains what mattered.",
      ),
    tickers: z
      .array(z.string())
      .default([])
      .describe(
        "Held tickers directly relevant to this chapter. Use an empty array for broad macro chapters without direct ticker mentions.",
      ),
  })
  .describe("[STRUCTURED OUTPUTS] Chapter block returned by the summary model.");

export const PortfolioTickerNewsChaptersSchema = z
  .object({
    ticker: z.string().describe("Held ticker symbol."),
    chapters: z
      .array(PortfolioNewsChapterSchema)
      .default([])
      .describe("Chapter summaries for this ticker."),
  })
  .describe("Portfolio news chapters grouped by ticker.");

const PortfolioTickerNewsChaptersModelSchema = z
  .object({
    ticker: z.string().describe("Held ticker symbol this group summarizes."),
    chapters: z
      .array(PortfolioNewsChapterModelSchema)
      .default([])
      .describe("One to three chapter blocks summarizing the most relevant news for this ticker."),
  })
  .describe("[STRUCTURED OUTPUTS] Ticker chapter group returned by the summary model.");

export const PortfolioNewsSummaryModelSchema = z
  .object({
    macros: z
      .array(PortfolioNewsChapterModelSchema)
      .default([])
      .describe("Zero to three chapter blocks about genuine market-wide or macro drivers."),
    top_tickers: z
      .array(PortfolioTickerNewsChaptersModelSchema)
      .default([])
      .describe(
        "Ticker groups for the requested top positions, preserving the provided priority order.",
      ),
  })
  .describe("[STRUCTURED OUTPUTS] Chaptered portfolio news summary returned by the summary model.");

export const PortfolioNewsSummaryRequestRowSchema = z
  .object({
    ticker: z.string().describe("Held ticker symbol."),
    quantity: z.number().nullable().optional().describe("Portfolio quantity for the held ticker."),
    total: z.number().nullable().optional().describe("Total notional value for the held ticker."),
    weight_pct: z
      .number()
      .nullable()
      .optional()
      .describe("Portfolio weight percentage for the held ticker."),
  })
  .describe("Portfolio row used as context for news summarization.");

export const PortfolioNewsSummaryRequestArticleSchema = z
  .object({
    title: z.string().nullable().optional().describe("Article headline."),
    summary: z
      .string()
      .default("")
      .describe("Article summary passed into the portfolio summarizer."),
    relevancy: z
      .enum(relevancyValues)
      .default("low")
      .describe("Ticker relevance classification from article analysis."),
    category: z
      .enum(newsCategoryValues)
      .default("other")
      .describe("Primary article category from article analysis."),
    sentiment: z
      .enum(sentimentValues)
      .default("neutral")
      .describe("Directional sentiment from article analysis."),
    source_tickers: z
      .array(z.string())
      .default([])
      .describe("Tickers associated with this article."),
  })
  .describe("News article context passed into portfolio summarization.");

export const PortfolioNewsSummaryRequestSchema = z
  .object({
    rows: z
      .array(PortfolioNewsSummaryRequestRowSchema)
      .default([])
      .describe("Portfolio rows that define held tickers and priority context."),
    items: z
      .array(PortfolioNewsSummaryRequestArticleSchema)
      .default([])
      .describe("Analyzed news items available for portfolio summarization."),
  })
  .describe("Portfolio news summary request payload.");

export const PortfolioNewsSummaryResponseTickerSchema = z
  .object({
    ticker: z.string().describe("Held ticker symbol."),
    weight_pct: z.number().default(0).describe("Portfolio weight percentage for this ticker."),
    chapters: z
      .array(PortfolioNewsChapterSchema)
      .default([])
      .describe("Final chapter summaries for this ticker."),
  })
  .describe("Ticker entry in the finalized portfolio news response.");

export const PortfolioNewsSummaryResponseSchema = z
  .object({
    has_news: z
      .boolean()
      .default(false)
      .describe("Whether the response contains any real news content."),
    macros: z
      .array(PortfolioNewsChapterSchema)
      .default([])
      .describe("Final macro or market-wide chapters."),
    top_tickers: z
      .array(PortfolioNewsSummaryResponseTickerSchema)
      .default([])
      .describe("Final top ticker summaries."),
  })
  .describe("Final portfolio news summary response.");

export const NewsRefreshStatusSchema = z
  .enum(["fresh", "partial", "failed"])
  .default("fresh")
  .describe("Refresh status for persisted portfolio news.");

export const NewsProducerSchema = z
  .enum(["external-agent", "app-local", "manual-import"])
  .default("external-agent")
  .describe("System that produced persisted portfolio news.");

export const TickerNewsGroupSchema = z
  .object({
    ticker: z.string().describe("Held ticker symbol."),
    articles: z
      .array(NewsArticleSchema)
      .default([])
      .describe("Display-ready raw-fast or analyzed news articles."),
    refreshed_at: z
      .string()
      .nullable()
      .optional()
      .describe("Timestamp when this ticker news group was refreshed."),
    status: NewsRefreshStatusSchema,
    error: z
      .string()
      .nullable()
      .optional()
      .describe("Refresh error detail when this ticker group is partial or failed."),
  })
  .describe("Persisted news articles for one ticker in a portfolio news payload.");

export const TickerNewsSummarySchema = z
  .object({
    ticker: z.string().describe("Held ticker symbol."),
    headline: z
      .string()
      .nullable()
      .optional()
      .describe("Optional headline for the ticker-level news summary."),
    summary: z.string().describe("Overall news summary for this ticker over the payload window."),
    relevancies: z
      .array(z.enum(summaryRelevancyValues))
      .default([])
      .describe(
        "Overall ticker-level news relevance labels in this payload. Use medium or high only; omit summaries that would be low relevance.",
      ),
    categories: z
      .array(z.enum(tickerSummaryCategoryValues))
      .default([])
      .describe("Primary ticker-level news categories covered by this summary."),
    labels: z
      .array(z.string())
      .default([])
      .describe(
        `Free-form daily driver labels such as ${tickerNewsSummaryLabelExamples.join(", ")}.`,
      ),
    source_urls: z
      .array(z.string())
      .default([])
      .describe("Optional article URLs used as references for this summary."),
    sentiments: z
      .array(z.enum(sentimentValues))
      .default([])
      .describe("Directional sentiment labels represented in this ticker summary."),
    status: NewsRefreshStatusSchema,
    error: z
      .string()
      .nullable()
      .optional()
      .describe("Refresh error detail when this ticker summary is partial or failed."),
  })
  .describe("Persisted overall news summary for one ticker.");

export const TickerNewsSummaryWriteSchema = z
  .object({
    ticker: z.string().describe("Held ticker symbol."),
    headline: z
      .string()
      .nullable()
      .optional()
      .describe("Optional headline for the ticker-level news summary."),
    summary: z.string().describe("Overall news summary for this ticker over the news window."),
    relevancies: z
      .array(z.enum(summaryRelevancyValues))
      .default(["medium"])
      .describe("Optional overall relevance labels; defaults to medium."),
    categories: z
      .array(z.enum(tickerSummaryCategoryValues))
      .default([])
      .describe("Optional ticker-level news categories covered by this summary."),
    labels: z
      .array(z.string())
      .default([])
      .describe(
        `Optional free-form daily driver labels such as ${tickerNewsSummaryLabelExamples.join(", ")}.`,
      ),
    source_urls: z
      .array(z.string())
      .default([])
      .describe("Optional article URLs used as references for this summary."),
    sentiments: z
      .array(z.enum(sentimentValues))
      .default([])
      .describe("Optional directional sentiment labels represented in this summary."),
  })
  .describe("Minimal ticker news summary accepted by the portfolio news writer.");

export const PortfolioNewsPayloadSchema = z
  .object({
    key: z.string().default("default").describe("Portfolio or cache scope key."),
    as_of_date: z.string().describe("Market date this portfolio news payload represents."),
    window_start: z
      .string()
      .nullable()
      .optional()
      .describe("Start date for the rolling news window."),
    window_end: z.string().nullable().optional().describe("End date for the rolling news window."),
    producer: NewsProducerSchema,
    refreshed_at: z
      .string()
      .default(() => new Date().toISOString())
      .describe("Timestamp when the full portfolio news payload was refreshed."),
    status: NewsRefreshStatusSchema,
    ticker_summaries: z
      .array(TickerNewsSummarySchema)
      .default([])
      .describe("Preferred compact external-agent output: one overall summary per ticker."),
    articles_by_ticker: z
      .array(TickerNewsGroupSchema)
      .default([])
      .describe(
        "Optional raw article evidence grouped by ticker. Not required for external-agent summary writes.",
      ),
    summary: PortfolioNewsSummaryResponseSchema.nullable()
      .optional()
      .describe("Optional externally written portfolio-level summary."),
    warnings: z.array(z.string()).default([]).describe("Non-fatal producer warnings."),
  })
  .describe("Shared DB payload for portfolio news articles and summary.");

export const PortfolioNewsWriteSchema = z
  .object({
    key: z.string().optional().describe("Optional portfolio news scope key; defaults to default."),
    as_of_date: z
      .string()
      .optional()
      .describe("Optional market date; defaults from window_end or today."),
    window_start: z
      .string()
      .nullable()
      .optional()
      .describe("Optional start date for the rolling news window."),
    window_end: z
      .string()
      .nullable()
      .optional()
      .describe("Optional end date for the rolling news window."),
    ticker_summaries: z
      .array(TickerNewsSummaryWriteSchema)
      .default([])
      .describe("One externally written overall news summary per ticker."),
  })
  .describe("Minimal agent write payload for portfolio news; system fields are filled by the app.");

export const PortfolioNewsSummaryWriteSchema = z
  .object({
    key: z.string().optional().describe("Optional portfolio news scope key; defaults to default."),
    as_of_date: z
      .string()
      .optional()
      .describe("Optional market date; defaults from the existing payload or today."),
    window_start: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Optional start date for the rolling news window; preserves the existing value when omitted.",
      ),
    window_end: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Optional end date for the rolling news window; preserves the existing value when omitted.",
      ),
    summary: PortfolioNewsSummaryResponseSchema.describe(
      "Externally written portfolio-level news summary.",
    ),
  })
  .describe("Minimal agent write payload for the portfolio-level news summary.");

export type NewsAnalysis = z.infer<typeof NewsAnalysisSchema>;
export type NotionalValue = z.infer<typeof NotionalSchema>;
export type ScoredReason = z.infer<typeof ScoredReasonSchema>;
export type MetricsEvaluation = z.infer<typeof MetricsEvaluationSchema>;
export type ResearchEvaluation = z.infer<typeof ResearchEvaluationSchema>;
export type FutureOutlook = z.infer<typeof FutureOutlookSchema>;
export type Evaluation = z.infer<typeof EvaluationSchema>;
export type TickerLabels = z.infer<typeof TickerLabelsSchema>;
export type NewsMetadata = z.infer<typeof NewsMetadataSchema>;
export type NewsArticle = z.infer<typeof NewsArticleSchema>;
export type PortfolioNewsChapter = z.infer<typeof PortfolioNewsChapterSchema>;
export type PortfolioTickerNewsChapters = z.infer<typeof PortfolioTickerNewsChaptersSchema>;
export type PortfolioNewsSummaryModel = z.infer<typeof PortfolioNewsSummaryModelSchema>;
export type PortfolioNewsSummaryRequestRow = z.infer<typeof PortfolioNewsSummaryRequestRowSchema>;
export type PortfolioNewsSummaryRequestArticle = z.infer<
  typeof PortfolioNewsSummaryRequestArticleSchema
>;
export type PortfolioNewsSummaryResponseTicker = z.infer<
  typeof PortfolioNewsSummaryResponseTickerSchema
>;
export type PortfolioNewsSummaryResponse = z.infer<typeof PortfolioNewsSummaryResponseSchema>;
export type NewsRefreshStatus = z.infer<typeof NewsRefreshStatusSchema>;
export type NewsProducer = z.infer<typeof NewsProducerSchema>;
export type TickerNewsGroup = z.infer<typeof TickerNewsGroupSchema>;
export type TickerNewsSummary = z.infer<typeof TickerNewsSummarySchema>;
export type TickerNewsSummaryWrite = z.infer<typeof TickerNewsSummaryWriteSchema>;
export type PortfolioNewsPayload = z.infer<typeof PortfolioNewsPayloadSchema>;
export type PortfolioNewsWrite = z.infer<typeof PortfolioNewsWriteSchema>;
export type PortfolioNewsSummaryWrite = z.infer<typeof PortfolioNewsSummaryWriteSchema>;
