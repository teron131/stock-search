/** Shared stock-search data schemas. */

import { z } from "zod";

import { INDUSTRY_LABELS } from "./labels.js";

const relevancyValues = ["high", "medium", "low"] as const;
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

function finiteNumber(value: unknown): number {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}

const ETF_MARKET_CAP_FIELDS = ["market_cap", "fx"] as const;

function isEtfIndicatorRow(row: Record<string, unknown>): boolean {
	return (
		String(row.quote_type ?? row.equity_type ?? "")
			.trim()
			.toUpperCase() === "ETF"
	);
}

/** Normalize indicator payloads before they are cached, persisted, or rendered. */
export function normalizeStockIndicators(
	value: unknown,
): Record<string, unknown> {
	const indicators =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? { ...(value as Record<string, unknown>) }
			: {};
	if (isEtfIndicatorRow(indicators)) {
		for (const field of ETF_MARKET_CAP_FIELDS) {
			indicators[field] = null;
		}
	}
	return indicators;
}

export const StockIndicatorsSchema = z
	.record(z.string(), z.unknown())
	.transform(normalizeStockIndicators);

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

export const NotionalSchema = z.object({
	from_stocks: z.number().default(0),
	from_etf: z.number().default(0),
	from_options: z.number().default(0),
});

export const NewsAnalysisSchema = z.object({
	summary: z.string().default(""),
	relevancy: z.enum(relevancyValues).default("low"),
	category: z.enum(newsCategoryValues).default("other"),
	sentiment: z.enum(sentimentValues).default("neutral"),
});

export const ScoredReasonSchema = z.object({
	score: z.number(),
	reasons: z.array(z.string()).default([]),
});

export const MetricsEvaluationSchema = z.object({
	market_cap_score: z.number().nullable().optional(),
	valuation_score: z.number().nullable().optional(),
	upside_score: z.number().nullable().optional(),
});

export const ResearchEvaluationSchema = z.object({
	moat_score: ScoredReasonSchema.nullable().optional(),
	quality_score: ScoredReasonSchema.nullable().optional(),
});

export const FutureOutlookSchema = ScoredReasonSchema.extend({
	bull_probability: z.number().nullable().optional(),
	bear_probability: z.number().nullable().optional(),
});

export const EvaluationSchema = MetricsEvaluationSchema.merge(
	ResearchEvaluationSchema,
)
	.merge(FutureOutlookSchema)
	.extend({
		flat_probability: z.number().nullable().optional(),
	});

export const TickerLabelsSchema = z.object({
	labels: z
		.array(z.string())
		.default([])
		.superRefine((labels, ctx) => {
			const invalidLabels = labels.filter(
				(label) => !INDUSTRY_LABELS.includes(label),
			);
			if (invalidLabels.length > 0) {
				ctx.addIssue({
					code: "custom",
					message: `labels must come from INDUSTRY_LABELS. Invalid: ${invalidLabels.join(", ")}`,
				});
			}
		}),
});

export const NewsMetadataSchema = z.object({
	provider: z.string().nullable().optional(),
	source_domain: z.string().nullable().optional(),
	published_at: z.string().nullable().optional(),
	fetched_at: z.string().nullable().optional(),
});

export const NewsArticleSchema = NewsAnalysisSchema.extend({
	url: z.string(),
	title: z.string().nullable().optional(),
	date: z.string().nullable().optional(),
	days_ago: z.number().int().nullable().optional(),
	metadata: NewsMetadataSchema.nullable().optional(),
});

export const PortfolioNewsChapterSchema = z.object({
	headline: z.string(),
	paragraph: z.string(),
	tickers: z.array(z.string()).default([]),
});

export const PortfolioTickerNewsChaptersSchema = z.object({
	ticker: z.string(),
	chapters: z.array(PortfolioNewsChapterSchema).default([]),
});

export const PortfolioNewsSummaryModelSchema = z.object({
	macros: z.array(PortfolioNewsChapterSchema).default([]),
	top_tickers: z.array(PortfolioTickerNewsChaptersSchema).default([]),
});

export const PortfolioNewsSummaryRequestRowSchema = z.object({
	ticker: z.string(),
	quantity: z.number().nullable().optional(),
	total: z.number().nullable().optional(),
	weight_pct: z.number().nullable().optional(),
});

export const PortfolioNewsSummaryRequestArticleSchema = z.object({
	title: z.string().nullable().optional(),
	summary: z.string().default(""),
	relevancy: z.enum(relevancyValues).default("low"),
	category: z.enum(newsCategoryValues).default("other"),
	sentiment: z.enum(sentimentValues).default("neutral"),
	source_tickers: z.array(z.string()).default([]),
});

export const PortfolioNewsSummaryRequestSchema = z.object({
	rows: z.array(PortfolioNewsSummaryRequestRowSchema).default([]),
	items: z.array(PortfolioNewsSummaryRequestArticleSchema).default([]),
});

export const PortfolioNewsSummaryResponseTickerSchema = z.object({
	ticker: z.string(),
	weight_pct: z.number().default(0),
	chapters: z.array(PortfolioNewsChapterSchema).default([]),
});

export const PortfolioNewsSummaryResponseSchema = z.object({
	has_news: z.boolean().default(false),
	macros: z.array(PortfolioNewsChapterSchema).default([]),
	top_tickers: z.array(PortfolioNewsSummaryResponseTickerSchema).default([]),
});

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
export type PortfolioTickerNewsChapters = z.infer<
	typeof PortfolioTickerNewsChaptersSchema
>;
export type PortfolioNewsSummaryModel = z.infer<
	typeof PortfolioNewsSummaryModelSchema
>;
export type PortfolioNewsSummaryRequestRow = z.infer<
	typeof PortfolioNewsSummaryRequestRowSchema
>;
export type PortfolioNewsSummaryRequestArticle = z.infer<
	typeof PortfolioNewsSummaryRequestArticleSchema
>;
export type PortfolioNewsSummaryResponseTicker = z.infer<
	typeof PortfolioNewsSummaryResponseTickerSchema
>;
export type PortfolioNewsSummaryResponse = z.infer<
	typeof PortfolioNewsSummaryResponseSchema
>;
