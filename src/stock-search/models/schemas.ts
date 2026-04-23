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

export const EvaluationSchema = MetricsEvaluationSchema
	.merge(ResearchEvaluationSchema)
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
