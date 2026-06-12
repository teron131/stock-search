/** Optionally summarize portfolio-level news from prepared article items. */

import { z } from "zod";
import {
	type NewsArticle,
	type PortfolioNewsChapter,
	PortfolioNewsChapterSchema,
	PortfolioNewsSummaryModelSchema,
	type PortfolioNewsSummaryRequestArticle,
	PortfolioNewsSummaryRequestArticleSchema,
	type PortfolioNewsSummaryRequestRow,
	PortfolioNewsSummaryRequestRowSchema,
	type PortfolioNewsSummaryResponse,
	PortfolioNewsSummaryResponseSchema,
	type PortfolioNewsSummaryResponseTicker,
	type PortfolioTickerNewsChapters,
} from "../../models/schemas.js";
import { PORTFOLIO_NEWS_SUMMARY_PROMPT } from "../../prompts.js";
import { normalizeTicker } from "../../utils.js";

const MAX_PORTFOLIO_SUMMARY_TICKERS = 5;
const MAX_PORTFOLIO_SUMMARY_ITEMS = 3;
const MAX_PORTFOLIO_SUMMARY_ARTICLES = 18;
const MAX_PORTFOLIO_SUMMARY_MACRO_ITEMS = 2;
const THIN_COVERAGE_HEADLINE = "Coverage remains thin";
const THIN_COVERAGE_PARAGRAPH =
	"Current feed does not surface a clear ticker-specific development yet.";
const MACRO_FALLBACK_CATEGORY_SCORES: Record<string, number> = {
	macro_economics: 2,
	market_news: 1,
};
const SUMMARY_HEADLINE_BLACKLIST = new Set([
	"theme",
	"takeaway",
	"setup",
	"weight",
	"backdrop",
	"cross-ticker",
	"company update",
	"news theme",
	"portfolio focus",
]);
const RELEVANCY_ORDER: Record<NewsArticle["relevancy"], number> = {
	high: 0,
	medium: 1,
	low: 2,
};
const STRUCTURED_OUTPUT_SCHEMA_KEYS_TO_DROP = new Set([
	"$schema",
	"description",
	"default",
	"title",
]);

type ChatOpenAIClient = (input: {
	model: string;
	temperature: number;
	reasoningEffort: "low";
}) => {
	withStructuredOutput(
		schema: unknown,
		options?: unknown,
	): {
		invoke(input: string): Promise<unknown> | unknown;
	};
};

export type PortfolioSummaryDeps = {
	chatOpenAI?: ChatOpenAIClient;
};

type PortfolioSummaryRow = {
	ticker: string;
	weight_pct: number;
};

type NormalizedSummaryItem = {
	title: string | null;
	summary: string;
	relevancy: NewsArticle["relevancy"];
	category: NewsArticle["category"];
	sentiment: NewsArticle["sentiment"];
	source_tickers: string[];
};

function stripStructuredOutputSchemaMetadata(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stripStructuredOutputSchemaMetadata);
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const nextValue: Record<string, unknown> = {};
	for (const [key, childValue] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (STRUCTURED_OUTPUT_SCHEMA_KEYS_TO_DROP.has(key)) {
			continue;
		}
		nextValue[key] = stripStructuredOutputSchemaMetadata(childValue);
	}
	return nextValue;
}

function portfolioNewsSummaryStructuredOutputSchema(): Record<string, unknown> {
	return stripStructuredOutputSchemaMetadata(
		z.toJSONSchema(PortfolioNewsSummaryModelSchema),
	) as Record<string, unknown>;
}

function formatPrompt(
	template: string,
	values: Record<string, string>,
): string {
	return template.replace(/\{([a-z_]+)\}/gi, (match, key) =>
		Object.hasOwn(values, key) ? values[key] : match,
	);
}

function normalizePortfolioNewsSummaryRows(
	rows: PortfolioNewsSummaryRequestRow[],
): PortfolioSummaryRow[] {
	const normalizedRows: PortfolioSummaryRow[] = [];
	const seenTickers = new Set<string>();

	const totalValue = rows.reduce((sum, row) => {
		const parsedRow = PortfolioNewsSummaryRequestRowSchema.parse(row);
		const quantity = Number(parsedRow.quantity ?? 0);
		const total = Number(parsedRow.total ?? 0);
		if (!parsedRow.ticker || quantity <= 0 || total <= 0) {
			return sum;
		}
		return sum + total;
	}, 0);

	for (const row of rows) {
		const parsedRow = PortfolioNewsSummaryRequestRowSchema.parse(row);
		const ticker = normalizeTicker(parsedRow.ticker);
		const quantity = Number(parsedRow.quantity ?? 0);
		if (!ticker || quantity <= 0 || seenTickers.has(ticker)) {
			continue;
		}

		seenTickers.add(ticker);
		let weightPct = Number(parsedRow.weight_pct ?? 0);
		if (weightPct <= 0) {
			const total = Number(parsedRow.total ?? 0);
			weightPct = totalValue > 0 && total > 0 ? (total / totalValue) * 100 : 0;
		}
		normalizedRows.push({
			ticker,
			weight_pct: weightPct,
		});
	}

	return normalizedRows.sort(
		(left, right) => right.weight_pct - left.weight_pct,
	);
}

function normalizePortfolioNewsSummaryItems(
	items: PortfolioNewsSummaryRequestArticle[],
	heldTickers: Set<string>,
): NormalizedSummaryItem[] {
	const normalizedItems: NormalizedSummaryItem[] = [];

	for (const item of items) {
		const parsedItem = PortfolioNewsSummaryRequestArticleSchema.parse(item);
		const summary = parsedItem.summary.trim().replace(/\s+/g, " ");
		if (!summary) {
			continue;
		}

		const sourceTickers: string[] = [];
		const seenTickers = new Set<string>();
		for (const ticker of parsedItem.source_tickers) {
			const normalizedTicker = normalizeTicker(ticker);
			if (
				!normalizedTicker ||
				!heldTickers.has(normalizedTicker) ||
				seenTickers.has(normalizedTicker)
			) {
				continue;
			}
			seenTickers.add(normalizedTicker);
			sourceTickers.push(normalizedTicker);
		}

		normalizedItems.push({
			title: parsedItem.title?.trim() ? parsedItem.title.trim() : null,
			summary,
			relevancy: parsedItem.relevancy,
			category: parsedItem.category,
			sentiment: parsedItem.sentiment,
			source_tickers: sourceTickers,
		});
	}

	return normalizedItems.slice(0, MAX_PORTFOLIO_SUMMARY_ARTICLES);
}

function normalizeSummaryTickers(
	tickers: string[],
	allowedTickers: Set<string>,
): string[] {
	const normalizedTickers: string[] = [];
	const seenTickers = new Set<string>();
	for (const ticker of tickers) {
		const normalizedTicker = normalizeTicker(ticker);
		if (
			!normalizedTicker ||
			!allowedTickers.has(normalizedTicker) ||
			seenTickers.has(normalizedTicker)
		) {
			continue;
		}
		seenTickers.add(normalizedTicker);
		normalizedTickers.push(normalizedTicker);
	}
	return normalizedTickers;
}

function cleanPortfolioNewsSummaryChapters(
	chapters: PortfolioNewsChapter[],
	{
		allowedTickers,
		fallbackTickers = [],
	}: {
		allowedTickers: Set<string>;
		fallbackTickers?: string[];
	},
): PortfolioNewsChapter[] {
	const cleanedChapters: PortfolioNewsChapter[] = [];
	for (const chapter of chapters) {
		const parsedChapter = PortfolioNewsChapterSchema.parse(chapter);
		const headline = parsedChapter.headline.trim().replace(/\s+/g, " ");
		const paragraph = parsedChapter.paragraph.trim().replace(/\s+/g, " ");
		if (!headline || !paragraph) {
			continue;
		}
		if (SUMMARY_HEADLINE_BLACKLIST.has(headline.toLowerCase())) {
			continue;
		}
		const tickers = normalizeSummaryTickers(
			parsedChapter.tickers,
			allowedTickers,
		);
		cleanedChapters.push({
			headline,
			paragraph,
			tickers:
				tickers.length > 0
					? tickers
					: fallbackTickers.filter((ticker) => allowedTickers.has(ticker)),
		});
		if (cleanedChapters.length >= MAX_PORTFOLIO_SUMMARY_ITEMS) {
			break;
		}
	}
	return cleanedChapters;
}

function titleCaseSummaryHeadline(text: string): string {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map((word) =>
			word.length <= 3
				? word.toUpperCase()
				: `${word[0].toUpperCase()}${word.slice(1)}`,
		)
		.join(" ");
}

function fallbackSummaryHeadline(title: string | null): string {
	if (!title) {
		return "Market thread";
	}

	let baseTitle = title.trim().replace(/\s+/g, " ");
	baseTitle = baseTitle.split("|", 1)[0];
	for (const separator of [":", ";", "-"]) {
		baseTitle = baseTitle.split(separator, 1)[0];
	}
	baseTitle = baseTitle.trim().replace(/\s+/g, " ");
	if (!baseTitle) {
		return "Market thread";
	}

	return titleCaseSummaryHeadline(baseTitle.split(/\s+/).slice(0, 6).join(" "));
}

function buildPortfolioNewsSummaryPrompt({
	heldTickers,
	topRows,
	normalizedItems,
}: {
	heldTickers: Set<string>;
	topRows: PortfolioSummaryRow[];
	normalizedItems: NormalizedSummaryItem[];
}): string {
	return formatPrompt(PORTFOLIO_NEWS_SUMMARY_PROMPT, {
		held_tickers_json: JSON.stringify([...heldTickers].sort()),
		top_positions_json: JSON.stringify(
			topRows.map((row, index) => ({
				ticker: row.ticker,
				priority_rank: index + 1,
			})),
		),
		news_items_json: JSON.stringify(normalizedItems),
	});
}

function fallbackTickerChapters({
	ticker,
	normalizedItems,
}: {
	ticker: string;
	normalizedItems: NormalizedSummaryItem[];
}): PortfolioNewsChapter[] {
	const tickerItems = normalizedItems.filter((item) =>
		item.source_tickers.includes(ticker),
	);
	if (tickerItems.length > 0) {
		return [
			{
				headline: THIN_COVERAGE_HEADLINE,
				paragraph: tickerItems[0].summary,
				tickers: [ticker],
			},
		];
	}

	return [
		{
			headline: THIN_COVERAGE_HEADLINE,
			paragraph: THIN_COVERAGE_PARAGRAPH,
			tickers: [ticker],
		},
	];
}

function fallbackMacroChapters({
	normalizedItems,
	heldTickers,
}: {
	normalizedItems: NormalizedSummaryItem[];
	heldTickers: Set<string>;
}): PortfolioNewsChapter[] {
	const macroCandidates: Array<{
		categoryScore: number;
		relevanceScore: number;
		breadthScore: number;
		positionScore: number;
		headline: string;
		paragraph: string;
		sourceTickers: string[];
	}> = [];
	const seenSummaries = new Set<string>();

	normalizedItems.forEach((item, index) => {
		const categoryScore = MACRO_FALLBACK_CATEGORY_SCORES[item.category];
		if (categoryScore === undefined) {
			return;
		}
		if (!item.summary || seenSummaries.has(item.summary)) {
			return;
		}
		seenSummaries.add(item.summary);
		const sourceTickers = item.source_tickers.filter((ticker) =>
			heldTickers.has(ticker),
		);
		macroCandidates.push({
			categoryScore,
			relevanceScore: -RELEVANCY_ORDER[item.relevancy],
			breadthScore: sourceTickers.length,
			positionScore: -index,
			headline: fallbackSummaryHeadline(item.title),
			paragraph: item.summary,
			sourceTickers,
		});
	});

	macroCandidates.sort((left, right) => {
		if (left.categoryScore !== right.categoryScore) {
			return right.categoryScore - left.categoryScore;
		}
		if (left.relevanceScore !== right.relevanceScore) {
			return right.relevanceScore - left.relevanceScore;
		}
		if (left.breadthScore !== right.breadthScore) {
			return right.breadthScore - left.breadthScore;
		}
		return right.positionScore - left.positionScore;
	});

	return macroCandidates
		.slice(0, MAX_PORTFOLIO_SUMMARY_MACRO_ITEMS)
		.map((candidate) => ({
			headline: candidate.headline,
			paragraph: candidate.paragraph,
			tickers: candidate.sourceTickers,
		}));
}

function buildTopTickerSummary({
	row,
	summaryByTicker,
	normalizedItems,
	heldTickers,
}: {
	row: PortfolioSummaryRow;
	summaryByTicker: Map<string, PortfolioTickerNewsChapters>;
	normalizedItems: NormalizedSummaryItem[];
	heldTickers: Set<string>;
}): PortfolioNewsSummaryResponseTicker {
	const summaryEntry = summaryByTicker.get(row.ticker);
	let chapters = cleanPortfolioNewsSummaryChapters(
		summaryEntry?.chapters ?? [],
		{
			allowedTickers: heldTickers,
			fallbackTickers: [row.ticker],
		},
	);
	if (chapters.length === 0) {
		chapters = fallbackTickerChapters({
			ticker: row.ticker,
			normalizedItems,
		});
	}

	return {
		ticker: row.ticker,
		weight_pct: row.weight_pct,
		chapters,
	};
}

function buildFallbackPortfolioNewsSummary({
	topRows,
	normalizedItems,
	heldTickers,
}: {
	topRows: PortfolioSummaryRow[];
	normalizedItems: NormalizedSummaryItem[];
	heldTickers: Set<string>;
}): PortfolioNewsSummaryResponse {
	const summaryByTicker = new Map<string, PortfolioTickerNewsChapters>();
	return PortfolioNewsSummaryResponseSchema.parse({
		has_news: true,
		macros: fallbackMacroChapters({
			normalizedItems,
			heldTickers,
		}),
		top_tickers: topRows.map((row) =>
			buildTopTickerSummary({
				row,
				summaryByTicker,
				normalizedItems,
				heldTickers,
			}),
		),
	});
}

export async function summarizePortfolioNews({
	rows,
	items,
	deps,
	fastModel,
}: {
	rows: PortfolioNewsSummaryRequestRow[];
	items: PortfolioNewsSummaryRequestArticle[];
	deps: PortfolioSummaryDeps;
	fastModel?: string;
}): Promise<PortfolioNewsSummaryResponse> {
	const normalizedRows = normalizePortfolioNewsSummaryRows(rows);
	if (normalizedRows.length === 0) {
		return PortfolioNewsSummaryResponseSchema.parse({
			has_news: false,
		});
	}

	const topRows = normalizedRows.slice(0, MAX_PORTFOLIO_SUMMARY_TICKERS);
	const heldTickers = new Set(normalizedRows.map((row) => row.ticker));
	const normalizedItems = normalizePortfolioNewsSummaryItems(
		items,
		heldTickers,
	);
	if (normalizedItems.length === 0) {
		return PortfolioNewsSummaryResponseSchema.parse({
			has_news: false,
		});
	}
	if (!deps.chatOpenAI || !fastModel) {
		return buildFallbackPortfolioNewsSummary({
			topRows,
			normalizedItems,
			heldTickers,
		});
	}

	const prompt = buildPortfolioNewsSummaryPrompt({
		heldTickers,
		topRows,
		normalizedItems,
	});
	let summary: z.infer<typeof PortfolioNewsSummaryModelSchema>;
	try {
		const model = deps
			.chatOpenAI({
				model: fastModel,
				temperature: 0,
				reasoningEffort: "low",
			})
			.withStructuredOutput(portfolioNewsSummaryStructuredOutputSchema(), {
				name: "portfolio_news_summary",
				method: "jsonSchema",
				strict: true,
			});
		summary = PortfolioNewsSummaryModelSchema.parse(await model.invoke(prompt));
	} catch {
		return buildFallbackPortfolioNewsSummary({
			topRows,
			normalizedItems,
			heldTickers,
		});
	}

	let macros = cleanPortfolioNewsSummaryChapters(summary.macros, {
		allowedTickers: heldTickers,
	});
	if (macros.length === 0) {
		macros = fallbackMacroChapters({
			normalizedItems,
			heldTickers,
		});
	}

	const summaryByTicker = new Map(
		summary.top_tickers.map((entry) => [normalizeTicker(entry.ticker), entry]),
	);
	const topTickers = topRows.map((row) =>
		buildTopTickerSummary({
			row,
			summaryByTicker,
			normalizedItems,
			heldTickers,
		}),
	);

	return PortfolioNewsSummaryResponseSchema.parse({
		has_news: true,
		macros,
		top_tickers: topTickers,
	});
}
