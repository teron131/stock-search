/** StockAnalysis-specific extraction into app snapshot shapes. */

import { ExaAnswerAgent, ExaLoadAgent } from "llm-harness-js/agents";
import { z, type ZodType } from "zod";

import { SECTOR_LABELS, SECTOR_PATTERN_RULES } from "../../models/labels.js";
import type {
	StockAnalysisEtfHolding,
	StockAnalysisEtfSector,
	StockAnalysisIndustrySnapshot,
	StockAnalysisIndustrySummary,
} from "./schemas.js";

const DEFAULT_CONTENT_OPTIONS = {
	maxCharacters: 20_000,
	maxAgeHours: 0,
	filterEmptyResults: false,
};

const LARGE_PAGE_MAX_CHARACTERS = 50_000;

const STOCKANALYSIS_SYSTEM_PROMPT = [
	"You extract structured data only from the supplied StockAnalysis page contents fetched through Exa Contents.",
	"Do not search, use memory, infer updated facts, or merge in outside values.",
	"Return null for fields absent from the supplied contents.",
	"Preserve displayed table row order.",
	"Use percentage fields as displayed percentage-point numbers, not fractions.",
].join(" ");

const STOCKANALYSIS_STATISTICS_URL =
	"https://stockanalysis.com/stocks/{ticker}/statistics/";
const STOCKANALYSIS_FINANCIALS_URL =
	"https://stockanalysis.com/stocks/{ticker}/financials/";
const STOCKANALYSIS_ETF_HOLDINGS_URL =
	"https://stockanalysis.com/etf/{ticker}/holdings/";
const STOCKANALYSIS_INDUSTRY_URL =
	"https://stockanalysis.com/stocks/industry/";
const STOCKANALYSIS_INDUSTRY_ALL_URL =
	"https://stockanalysis.com/stocks/industry/all/";

const NullableNumber = z.number().nullable();

const QuoteFieldsSchema = z.object({
	price: NullableNumber.optional(),
	change: NullableNumber.optional(),
	change_percent_1d: NullableNumber.optional(),
});

const RatingRowSchema = z.object({
	firm: z.string().nullable().optional(),
	to_grade: z.string().nullable().optional(),
	from_grade: z.string().nullable().optional(),
	action: z.string().nullable().optional(),
	date: z.string().nullable().optional(),
	analyst_count: NullableNumber.optional(),
	price_target: NullableNumber.optional(),
	upside_pct: NullableNumber.optional(),
});

const StatisticsSchema = z.object({
	market_cap: NullableNumber.optional(),
	beta: NullableNumber.optional(),
	fifty_two_week_price_change: NullableNumber.optional(),
	moving_average_50d: NullableNumber.optional(),
	moving_average_200d: NullableNumber.optional(),
	rsi: NullableNumber.optional(),
	average_volume_20d: NullableNumber.optional(),
	pe: NullableNumber.optional(),
	pe_forward: NullableNumber.optional(),
	peg: NullableNumber.optional(),
	roic: NullableNumber.optional(),
	gross_margin: NullableNumber.optional(),
	operating_margin: NullableNumber.optional(),
	debt_to_equity: NullableNumber.optional(),
	debt_to_ebitda: NullableNumber.optional(),
	free_cash_flow: NullableNumber.optional(),
	median_upside: NullableNumber.optional(),
	ratings: z.array(RatingRowSchema).nullable().optional(),
});

const FinancialsSchema = z.object({
	revenue_growth: NullableNumber.optional(),
	eps_diluted: NullableNumber.optional(),
	eps_growth: NullableNumber.optional(),
	gross_margin: NullableNumber.optional(),
	operating_margin: NullableNumber.optional(),
});

const EtfHoldingSchema = z.object({
	ticker: z.string(),
	name: z.string().nullable().optional(),
	weight: z.number(),
});

const EtfHoldingsSchema = z.object({
	holdings: z.array(EtfHoldingSchema).default([]),
});

const EtfSectorSchema = z.object({
	name: z.string(),
	weight: z.number(),
});

const EtfSectorsSchema = z.object({
	sectors: z.array(EtfSectorSchema).default([]),
});

const IndustryRowSchema = z.object({
	sector: z.string(),
	industry: z.string(),
	stock_count: z.number(),
	market_cap: NullableNumber,
	pe: NullableNumber,
	profit_margin: NullableNumber,
	gross_margin: NullableNumber,
	change_percent_1d: NullableNumber,
	change_percent_1m: NullableNumber,
	change_percent_1y: NullableNumber,
});

const IndustrySnapshotSchema = z.object({
	industries: z.array(IndustryRowSchema).default([]),
});

type QuoteFields = z.output<typeof QuoteFieldsSchema>;

function stockUrl(template: string, tickerLower: string): string {
	return template.replace("{ticker}", tickerLower);
}

function normalizeSectorName(value: string): string {
	const sectorText = value.trim();
	for (const label of Object.values(SECTOR_LABELS)) {
		if (sectorText.toLowerCase() === label.toLowerCase()) {
			return label;
		}
	}
	for (const [pattern, label] of SECTOR_PATTERN_RULES) {
		if (new RegExp(pattern, "i").test(sectorText)) {
			return label;
		}
	}
	return SECTOR_LABELS.other;
}

async function loadStockAnalysisPage<T extends ZodType>({
	urls,
	outputSchema,
	instruction,
	maxCharacters = DEFAULT_CONTENT_OPTIONS.maxCharacters,
}: {
	urls: string | string[];
	outputSchema: T;
	instruction: string;
	maxCharacters?: number;
}): Promise<z.output<T>> {
	const agent = new ExaLoadAgent<T>({
		outputSchema,
		contentOptions: {
			...DEFAULT_CONTENT_OPTIONS,
			maxCharacters,
		},
		systemPrompt: STOCKANALYSIS_SYSTEM_PROMPT,
	});
	return (await agent.invoke(urls, instruction)) as z.output<T>;
}

async function loadStockAnalysisPageOrDefault<T extends ZodType>({
	urls,
	outputSchema,
	instruction,
	defaultValue,
	maxCharacters,
}: {
	urls: string | string[];
	outputSchema: T;
	instruction: string;
	defaultValue: z.output<T>;
	maxCharacters?: number;
}): Promise<z.output<T>> {
	try {
		return await loadStockAnalysisPage({
			urls,
			outputSchema,
			instruction,
			maxCharacters,
		});
	} catch {
		return defaultValue;
	}
}

async function answerWithExaOrDefault<T extends ZodType>({
	query,
	outputSchema,
	systemPrompt,
	defaultValue,
}: {
	query: string;
	outputSchema: T;
	systemPrompt: string;
	defaultValue: z.output<T>;
}): Promise<z.output<T>> {
	try {
		return await new ExaAnswerAgent(systemPrompt, outputSchema).invoke(query);
	} catch {
		return defaultValue;
	}
}

/** Load quote fields from a StockAnalysis statistics page. */
export async function loadQuoteFields(
	tickerLower: string,
): Promise<Required<QuoteFields>> {
	const url = stockUrl(STOCKANALYSIS_STATISTICS_URL, tickerLower);
	const output = await loadStockAnalysisPageOrDefault({
		urls: url,
		outputSchema: QuoteFieldsSchema,
		defaultValue: {
			price: null,
			change: null,
			change_percent_1d: null,
		},
		instruction: [
			`Extract current quote fields for ${tickerLower.toUpperCase()} from the supplied StockAnalysis statistics page.`,
			"Return price, absolute change, and one-day change percentage if explicitly displayed.",
		].join("\n"),
	});
	return {
		price: output.price ?? null,
		change: output.change ?? null,
		change_percent_1d: output.change_percent_1d ?? null,
	};
}

/** Load the StockAnalysis statistics page into the app statistics shape. */
export async function loadStatisticsSnapshot(
	tickerLower: string,
): Promise<Record<string, unknown>> {
	const url = stockUrl(STOCKANALYSIS_STATISTICS_URL, tickerLower);
	return loadStockAnalysisPageOrDefault({
		urls: url,
		outputSchema: StatisticsSchema,
		defaultValue: {},
		instruction: [
			`Extract the StockAnalysis statistics schema for ${tickerLower.toUpperCase()}.`,
			`Source URL: ${url}`,
			"Use market_cap and free_cash_flow as absolute dollar values.",
			"Use pe, pe_forward, peg, beta, roic, debt_to_equity, and debt_to_ebitda as displayed numeric ratios.",
			"Use gross_margin, operating_margin, rsi, median_upside, and price-change fields as 0-100 numeric values.",
			"If analyst consensus and price-target fields are visible, return one ratings row with firm 'Consensus'.",
		].join("\n"),
	});
}

/** Load the StockAnalysis financials page into the app financials shape. */
export async function loadFinancialsSnapshot(
	tickerLower: string,
): Promise<Record<string, unknown>> {
	const url = stockUrl(STOCKANALYSIS_FINANCIALS_URL, tickerLower);
	return loadStockAnalysisPageOrDefault({
		urls: url,
		outputSchema: FinancialsSchema,
		defaultValue: {},
		instruction: [
			`Extract the StockAnalysis financials schema for ${tickerLower.toUpperCase()}.`,
			`Source URL: ${url}`,
			"Use only the first/current data column in the table.",
			"Ignore older columns to the right.",
			"Use revenue_growth, eps_growth, gross_margin, and operating_margin as 0-100 numeric values.",
		].join("\n"),
	});
}

/** Load ETF holdings from the StockAnalysis holdings page. */
export async function loadEtfHoldingsSnapshot(
	tickerLower: string,
): Promise<StockAnalysisEtfHolding[]> {
	const url = stockUrl(STOCKANALYSIS_ETF_HOLDINGS_URL, tickerLower);
	const output = await loadStockAnalysisPageOrDefault({
		urls: url,
		outputSchema: EtfHoldingsSchema,
		defaultValue: { holdings: [] },
		instruction: [
			`Extract ETF holdings for ${tickerLower.toUpperCase()} from the supplied StockAnalysis holdings table.`,
			`Source URL: ${url}`,
			"Return holdings in displayed table order.",
			"Use weight as a 0-100 numeric percentage.",
			"Preserve non-US exchange prefixes or suffixes when StockAnalysis displays them.",
			"Exclude US exchange prefixes.",
		].join("\n"),
	});
	return output.holdings.map((holding) => ({
		ticker: holding.ticker,
		name: holding.name ?? null,
		weight: holding.weight,
	}));
}

/** Load ETF sector allocation from web search when page contents omit it. */
export async function loadEtfSectorsSnapshot(
	tickerLower: string,
): Promise<StockAnalysisEtfSector[]> {
	const ticker = tickerLower.toUpperCase();
	const today = new Date().toISOString().slice(0, 10);
	const output = await answerWithExaOrDefault({
		outputSchema: EtfSectorsSchema,
		defaultValue: { sectors: [] },
		query: [
			`As of ${today}, find the latest sector allocation or sector exposure breakdown for ETF ${ticker}.`,
			"Prefer the ETF issuer's official website, factsheet, holdings CSV, or fund page.",
			"Use StockAnalysis or Schwab only if an issuer source is not available.",
			"Do not use Yahoo.",
		].join(" "),
		systemPrompt: [
			"You extract ETF sector allocation data for a portfolio cache.",
			"Freshness and source quality matter: prefer official issuer sources first, then StockAnalysis, then Schwab.",
			"Return sectors only when a source explicitly shows sector allocation, sector exposure, or sector breakdown for the ETF.",
			"Do not infer sectors from holdings, company names, labels, or memory.",
			"Use numeric weights in 0-100 percentage format.",
			"Normalize sector names to concise display labels such as Technology, Healthcare, Financials, Consumer Cyclical, Consumer Defensive, Industrials, Energy, Utilities, Real Estate, Communication Services, Materials, or Other.",
			"Prefer a complete sector breakdown whose weights sum approximately to 100.",
			"If unavailable or ambiguous, return an empty sectors array.",
		].join("\n"),
	});
	return output.sectors.map((sector) => ({
		name: normalizeSectorName(sector.name),
		weight: sector.weight,
	}));
}

/** Load sector and industry summary rows from StockAnalysis industry pages. */
export async function loadIndustrySnapshot(): Promise<StockAnalysisIndustrySnapshot> {
	const output = await loadStockAnalysisPageOrDefault({
		urls: [STOCKANALYSIS_INDUSTRY_URL, STOCKANALYSIS_INDUSTRY_ALL_URL],
		outputSchema: IndustrySnapshotSchema,
		defaultValue: { industries: [] },
		maxCharacters: LARGE_PAGE_MAX_CHARACTERS,
		instruction: [
			"Extract StockAnalysis sector and industry summary rows from the supplied industry pages.",
			"Return every industry row visible in the supplied contents.",
			"Use stock_count as an integer count.",
			"Use market_cap as absolute dollars when displayed; otherwise null.",
			"Use profit_margin, gross_margin, and change_percent fields as 0-100 numeric values.",
		].join("\n"),
	});
	const industries = output.industries.filter(
		(row): row is StockAnalysisIndustrySummary =>
			!!row.sector && !!row.industry && Number.isFinite(row.stock_count),
	);
	return {
		industries,
		meta: {
			source: "stockanalysis",
			fetched_at: industries.length > 0 ? new Date().toISOString() : null,
			sector_count: new Set(industries.map((row) => row.sector)).size,
			industry_count: industries.length,
		},
	};
}
