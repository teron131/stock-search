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

export const newsAnalysisSchema = z.object({
	summary: z.string().default(""),
	relevancy: z.enum(relevancyValues).default("low"),
	category: z.enum(newsCategoryValues).default("other"),
	sentiment: z.enum(sentimentValues).default("neutral"),
});

export const scoredReasonSchema = z.object({
	score: z.number(),
	reasons: z.array(z.string()).default([]),
});

export const metricsEvaluationSchema = z.object({
	market_cap_score: z.number().nullable().optional(),
	valuation_score: z.number().nullable().optional(),
	upside_score: z.number().nullable().optional(),
});

export const researchEvaluationSchema = z.object({
	moat_score: scoredReasonSchema.nullable().optional(),
	quality_score: scoredReasonSchema.nullable().optional(),
});

export const futureOutlookSchema = scoredReasonSchema.extend({
	bull_probability: z.number().nullable().optional(),
	bear_probability: z.number().nullable().optional(),
});

export const evaluationSchema = metricsEvaluationSchema
	.merge(researchEvaluationSchema)
	.merge(futureOutlookSchema)
	.extend({
		flat_probability: z.number().nullable().optional(),
	});

export const tickerLabelsSchema = z.object({
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

export const newsMetadataSchema = z.object({
	provider: z.string().nullable().optional(),
	source_domain: z.string().nullable().optional(),
	published_at: z.string().nullable().optional(),
	fetched_at: z.string().nullable().optional(),
});

export const newsArticleSchema = newsAnalysisSchema.extend({
	url: z.string(),
	title: z.string().nullable().optional(),
	date: z.string().nullable().optional(),
	days_ago: z.number().int().nullable().optional(),
	metadata: newsMetadataSchema.nullable().optional(),
});

export const portfolioNewsChapterSchema = z.object({
	headline: z.string(),
	paragraph: z.string(),
	tickers: z.array(z.string()).default([]),
});

export const portfolioTickerNewsChaptersSchema = z.object({
	ticker: z.string(),
	chapters: z.array(portfolioNewsChapterSchema).default([]),
});

export const portfolioNewsSummaryModelSchema = z.object({
	macros: z.array(portfolioNewsChapterSchema).default([]),
	top_tickers: z.array(portfolioTickerNewsChaptersSchema).default([]),
});

export const portfolioNewsSummaryRequestRowSchema = z.object({
	ticker: z.string(),
	quantity: z.number().nullable().optional(),
	total: z.number().nullable().optional(),
	weight_pct: z.number().nullable().optional(),
});

export const portfolioNewsSummaryRequestArticleSchema = z.object({
	title: z.string().nullable().optional(),
	summary: z.string().default(""),
	relevancy: z.enum(relevancyValues).default("low"),
	category: z.enum(newsCategoryValues).default("other"),
	sentiment: z.enum(sentimentValues).default("neutral"),
	source_tickers: z.array(z.string()).default([]),
});

export const portfolioNewsSummaryRequestSchema = z.object({
	rows: z.array(portfolioNewsSummaryRequestRowSchema).default([]),
	items: z.array(portfolioNewsSummaryRequestArticleSchema).default([]),
});

export const portfolioNewsSummaryResponseTickerSchema = z.object({
	ticker: z.string(),
	weight_pct: z.number().default(0),
	chapters: z.array(portfolioNewsChapterSchema).default([]),
});

export const portfolioNewsSummaryResponseSchema = z.object({
	has_news: z.boolean().default(false),
	macros: z.array(portfolioNewsChapterSchema).default([]),
	top_tickers: z.array(portfolioNewsSummaryResponseTickerSchema).default([]),
});

export type NewsAnalysis = z.infer<typeof newsAnalysisSchema>;
export type ScoredReason = z.infer<typeof scoredReasonSchema>;
export type MetricsEvaluation = z.infer<typeof metricsEvaluationSchema>;
export type ResearchEvaluation = z.infer<typeof researchEvaluationSchema>;
export type FutureOutlook = z.infer<typeof futureOutlookSchema>;
export type Evaluation = z.infer<typeof evaluationSchema>;
export type TickerLabels = z.infer<typeof tickerLabelsSchema>;
export type NewsMetadata = z.infer<typeof newsMetadataSchema>;
export type NewsArticle = z.infer<typeof newsArticleSchema>;
export type PortfolioNewsChapter = z.infer<typeof portfolioNewsChapterSchema>;
export type PortfolioTickerNewsChapters = z.infer<
	typeof portfolioTickerNewsChaptersSchema
>;
export type PortfolioNewsSummaryModel = z.infer<
	typeof portfolioNewsSummaryModelSchema
>;
export type PortfolioNewsSummaryRequestRow = z.infer<
	typeof portfolioNewsSummaryRequestRowSchema
>;
export type PortfolioNewsSummaryRequestArticle = z.infer<
	typeof portfolioNewsSummaryRequestArticleSchema
>;
export type PortfolioNewsSummaryResponseTicker = z.infer<
	typeof portfolioNewsSummaryResponseTickerSchema
>;
export type PortfolioNewsSummaryResponse = z.infer<
	typeof portfolioNewsSummaryResponseSchema
>;
