/** StockAnalysis-specific extraction into app snapshot shapes. */

import path from "node:path";

import { ExaAnswerAgent, ExaLoadAgent } from "llm-harness-js/agents";
import { type ZodType, z } from "zod";

import { appConfig } from "../../api/config.js";
import {
	isCacheTimestampFresh,
	loadJsonCache,
	writeJsonCache,
} from "../../cache.js";
import { getFieldDescription } from "../../models/field-definitions.js";
import { SECTOR_LABELS, SECTOR_PATTERN_RULES } from "../../models/labels.js";
import { stockAnalysisStockPathForTicker } from "../provider-symbols.js";
import type {
	StockAnalysisEtfHolding,
	StockAnalysisEtfSector,
	StockAnalysisSectorSnapshot,
	StockAnalysisSectorSummary,
} from "./schemas.js";

const DEFAULT_CONTENT_OPTIONS = {
	maxCharacters: 20_000,
	maxAgeHours: 0,
	filterEmptyResults: false,
};

const STOCKANALYSIS_SYSTEM_PROMPT = [
	"You extract structured data only from the supplied StockAnalysis page contents fetched through Exa Contents.",
	"Do not search, use memory, infer updated facts, or merge in outside values.",
	"Return null for fields absent from the supplied contents.",
	"Preserve displayed table row order.",
	"Use percentage fields as displayed percentage-point numbers, not fractions.",
].join(" ");

const STOCKANALYSIS_OVERVIEW_URL = "https://stockanalysis.com/stocks/{ticker}/";
const STOCKANALYSIS_STATISTICS_URL =
	"https://stockanalysis.com/stocks/{ticker}/statistics/";
const STOCKANALYSIS_FINANCIALS_URL =
	"https://stockanalysis.com/stocks/{ticker}/financials/";
const STOCKANALYSIS_ETF_HOLDINGS_URL =
	"https://stockanalysis.com/etf/{ticker}/holdings/";
const STOCKANALYSIS_SECTORS_URL =
	"https://stockanalysis.com/stocks/industry/sectors/";
const STOCKANALYSIS_SECTOR_URL =
	"https://stockanalysis.com/stocks/sector/{sector}/";
const SECTOR_SNAPSHOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SECTOR_TOP_TICKER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SECTOR_TOP_TICKER_COUNT = 5;
const SECTOR_TOP_TICKER_PAGE_MAX_CHARACTERS = 40_000;
const SECTOR_SNAPSHOT_CACHE_PATH = path.join(
	path.dirname(appConfig.dataSqlitePath),
	"stockanalysis-sectors.json",
);
const SECTOR_TOP_TICKER_CACHE_PATH = path.join(
	path.dirname(appConfig.dataSqlitePath),
	"stockanalysis-sector-top-tickers.json",
);
const NULL_NUMBER_TEXTS = new Set(["-", "--", "n/a", "na", "none"]);
const NUMBER_SUFFIX_MULTIPLIERS: Record<string, number> = {
	K: 1e3,
	M: 1e6,
	B: 1e9,
	T: 1e12,
};
const PARSED_STATISTICS_REQUIRED_FIELDS = [
	"market_cap",
	"revenue",
	"pe",
	"pe_forward",
	"ps",
	"peg",
] as const satisfies readonly StatisticsFieldName[];
const FINANCIALS_MONETARY_FIELDS = new Set<FinancialsFieldName>([
	"revenue",
	"free_cash_flow",
]);

const NullableNumber = z
	.number()
	.nullable()
	.describe("Numeric value extracted from StockAnalysis, or null if absent.");

const QuoteFieldsSchema = z
	.object({
		price: NullableNumber.optional().describe(
			"Current stock price shown in the StockAnalysis quote header.",
		),
		change: NullableNumber.optional().describe(
			"Absolute one-day price change shown beside the current stock price.",
		),
		change_percent_1d: NullableNumber.optional().describe(
			"One-day percentage change shown beside the current stock price.",
		),
	})
	.describe(
		"Quote header fields extracted from the StockAnalysis overview page.",
	);

const RatingRowSchema = z
	.object({
		firm: z.string().nullable().optional().describe("Analyst firm name."),
		to_grade: z
			.string()
			.nullable()
			.optional()
			.describe("Analyst Consensus value from the Analyst Forecast section."),
		from_grade: z
			.string()
			.nullable()
			.optional()
			.describe(
				"Previous analyst rating grade, if a rating table provides one.",
			),
		action: z
			.string()
			.nullable()
			.optional()
			.describe("Rating action if a rating table provides one."),
		date: z
			.string()
			.nullable()
			.optional()
			.describe("Rating action date if a rating table provides one."),
		analyst_count: NullableNumber.optional().describe(
			"Analyst Count value from the Analyst Forecast section.",
		),
		price_target: NullableNumber.optional().describe(
			"Price Target value from the Analyst Forecast section.",
		),
		upside_pct: NullableNumber.optional().describe(
			"Price Target Difference percentage from the Analyst Forecast section.",
		),
	})
	.describe(
		"Analyst forecast row extracted from the StockAnalysis statistics page.",
	);

const StatisticsSchema = z
	.object({
		market_cap: NullableNumber.optional().describe(
			getFieldDescription("market_cap"),
		),
		revenue: NullableNumber.optional().describe(getFieldDescription("revenue")),
		beta: NullableNumber.optional().describe(getFieldDescription("beta")),
		fifty_two_week_price_change: NullableNumber.optional().describe(
			"52-Week Price Change percentage from the Stock Price Statistics section.",
		),
		moving_average_50d: NullableNumber.optional().describe(
			"50-Day Moving Average value from the Stock Price Statistics section.",
		),
		moving_average_200d: NullableNumber.optional().describe(
			"200-Day Moving Average value from the Stock Price Statistics section.",
		),
		rsi: NullableNumber.optional().describe(getFieldDescription("rsi")),
		average_volume_20d: NullableNumber.optional().describe(
			"Average Volume (20 Days) value from the Stock Price Statistics section.",
		),
		pe: NullableNumber.optional().describe(getFieldDescription("pe")),
		pe_forward: NullableNumber.optional().describe(
			getFieldDescription("pe_forward"),
		),
		ps: NullableNumber.optional().describe(getFieldDescription("ps")),
		ps_forward: NullableNumber.optional().describe(
			getFieldDescription("ps_forward"),
		),
		peg: NullableNumber.optional().describe(getFieldDescription("peg")),
		roe: NullableNumber.optional().describe(getFieldDescription("roe")),
		roic: NullableNumber.optional().describe(getFieldDescription("roic")),
		gross_margin: NullableNumber.optional().describe(
			getFieldDescription("gross_margin"),
		),
		operating_margin: NullableNumber.optional().describe(
			getFieldDescription("operating_margin"),
		),
		debt_to_equity: NullableNumber.optional().describe(
			getFieldDescription("debt_to_equity"),
		),
		debt_to_ebitda: NullableNumber.optional().describe(
			"Debt / EBITDA value from the Financial Position section.",
		),
		free_cash_flow: NullableNumber.optional().describe(
			getFieldDescription("free_cash_flow"),
		),
		shareholder_yield: NullableNumber.optional().describe(
			getFieldDescription("shareholder_yield"),
		),
		median_upside: NullableNumber.optional().describe(
			getFieldDescription("median_upside"),
		),
		ratings: z
			.array(RatingRowSchema)
			.nullable()
			.optional()
			.describe("Consensus analyst forecast row, when visible."),
	})
	.describe("Fundamental and market statistics extracted from StockAnalysis.");

const FinancialsSchema = z
	.object({
		revenue: NullableNumber.optional().describe(
			"Revenue from the first/current column, converted to absolute dollars using the page unit label.",
		),
		revenue_growth: NullableNumber.optional().describe(
			getFieldDescription("revenue_growth"),
		),
		eps_diluted: NullableNumber.optional().describe(
			"EPS (Diluted) value from the first/current column.",
		),
		eps_growth: NullableNumber.optional().describe(
			"EPS Growth percentage from the EPS Growth row in the first/current column. Do not use EPS (Diluted) or Shares Change (YoY).",
		),
		gross_margin: NullableNumber.optional().describe(
			getFieldDescription("gross_margin"),
		),
		operating_margin: NullableNumber.optional().describe(
			getFieldDescription("operating_margin"),
		),
		free_cash_flow: NullableNumber.optional().describe(
			"Free cash flow from the first/current column, converted to absolute dollars using the page unit label.",
		),
	})
	.describe(
		"Income statement fields extracted from the StockAnalysis financials page.",
	);

const EtfHoldingSchema = z
	.object({
		ticker: z.string().describe("ETF holding ticker symbol."),
		name: z
			.string()
			.nullable()
			.optional()
			.describe("ETF holding company name."),
		weight: z.number().describe("ETF holding portfolio weight percentage."),
	})
	.describe("One ETF holding extracted from StockAnalysis.");

const EtfHoldingsSchema = z
	.object({
		holdings: z
			.array(EtfHoldingSchema)
			.default([])
			.describe("ETF holdings ranked by portfolio weight."),
	})
	.describe("ETF holdings payload extracted from StockAnalysis.");

const EtfSectorSchema = z
	.object({
		name: z.string().describe("ETF sector name."),
		weight: z.number().describe("ETF sector portfolio weight percentage."),
	})
	.describe("One ETF sector exposure row extracted from StockAnalysis.");

const EtfSectorsSchema = z
	.object({
		sectors: z
			.array(EtfSectorSchema)
			.default([])
			.describe("ETF sector exposure rows."),
	})
	.describe("ETF sector exposure payload extracted from StockAnalysis.");

const SectorRowSchema = z
	.object({
		sector: z.string().describe("StockAnalysis sector name."),
		stock_count: z.number().describe("Number of stocks in the sector."),
		market_cap: NullableNumber.describe("Aggregate sector market cap."),
		pe: NullableNumber.describe("Aggregate sector PE ratio."),
		profit_margin: NullableNumber.describe("Aggregate sector profit margin."),
		change_percent_1d: NullableNumber.describe(
			"Sector one-day change percent.",
		),
		change_percent_1y: NullableNumber.describe(
			"Sector one-year change percent.",
		),
	})
	.describe("One StockAnalysis sector snapshot row.");

const SectorSnapshotSchema = z
	.object({
		sectors: z
			.array(SectorRowSchema)
			.default([])
			.describe("Current sector snapshot rows."),
	})
	.describe("Current StockAnalysis sector snapshot.");

const SectorSnapshotCacheSchema = z
	.object({
		fetched_at: z
			.string()
			.nullable()
			.default(null)
			.describe("Timestamp when the sector snapshot cache was fetched."),
		sectors: z
			.array(SectorRowSchema)
			.default([])
			.describe("Cached sector snapshot rows."),
	})
	.describe("Cached StockAnalysis sector snapshot.");

const SectorTopTickerCacheEntrySchema = z
	.object({
		fetched_at: z
			.string()
			.describe("Timestamp when the sector top-ticker list was fetched."),
		tickers: z
			.array(z.string())
			.default([])
			.describe("Representative top tickers for the sector."),
	})
	.describe("Cached top-ticker list for one StockAnalysis sector.");

const SectorTopTickerCacheSchema = z
	.object({
		entries: z
			.record(z.string(), SectorTopTickerCacheEntrySchema)
			.default({})
			.describe("Sector top-ticker cache entries keyed by sector name."),
	})
	.describe("Cached StockAnalysis sector top-ticker payload.");

type FinancialsFieldName =
	| "revenue"
	| "revenue_growth"
	| "eps_diluted"
	| "eps_growth"
	| "gross_margin"
	| "operating_margin"
	| "free_cash_flow";
type StatisticsFieldName =
	| "market_cap"
	| "revenue"
	| "beta"
	| "fifty_two_week_price_change"
	| "moving_average_50d"
	| "moving_average_200d"
	| "rsi"
	| "average_volume_20d"
	| "pe"
	| "pe_forward"
	| "ps"
	| "ps_forward"
	| "peg"
	| "roe"
	| "roic"
	| "gross_margin"
	| "operating_margin"
	| "debt_to_equity"
	| "debt_to_ebitda"
	| "free_cash_flow"
	| "shareholder_yield"
	| "median_upside";

const FINANCIALS_ROW_FIELDS: Record<string, FinancialsFieldName> = {
	Revenue: "revenue",
	"Total Revenue": "revenue",
	"Revenues Before Loan Losses": "revenue",
	"Revenue Growth (YoY)": "revenue_growth",
	"EPS (Diluted)": "eps_diluted",
	"EPS Growth": "eps_growth",
	"Gross Margin": "gross_margin",
	"Operating Margin": "operating_margin",
	"Free Cash Flow": "free_cash_flow",
};
const STATISTICS_ROW_FIELDS: Record<string, StatisticsFieldName> = {
	"Market Cap": "market_cap",
	"Revenue (ttm)": "revenue",
	Revenue: "revenue",
	Beta: "beta",
	"52-Week Price Change": "fifty_two_week_price_change",
	"50-Day Moving Average": "moving_average_50d",
	"200-Day Moving Average": "moving_average_200d",
	"Relative Strength Index (RSI)": "rsi",
	"Average Volume (20 Days)": "average_volume_20d",
	"PE Ratio": "pe",
	"Forward PE": "pe_forward",
	"PS Ratio": "ps",
	"Forward PS": "ps_forward",
	"PEG Ratio": "peg",
	"Return on Equity (ROE)": "roe",
	"Return on Invested Capital (ROIC)": "roic",
	"Gross Margin": "gross_margin",
	"Operating Margin": "operating_margin",
	"Debt / Equity": "debt_to_equity",
	"Debt / EBITDA": "debt_to_ebitda",
	"Free Cash Flow": "free_cash_flow",
	"Shareholder Yield": "shareholder_yield",
	"Price Target Difference": "median_upside",
};

type SectorRow = z.output<typeof SectorRowSchema>;

type SectorSnapshotCache = z.output<typeof SectorSnapshotCacheSchema>;

type SectorTopTickerCache = z.output<typeof SectorTopTickerCacheSchema>;

type SectorTopTickerCacheMatch = {
	freshTickers: string[] | null;
	fallbackTickers: string[] | null;
};

type QuoteFields = z.output<typeof QuoteFieldsSchema>;

function stockUrl(template: string, tickerLower: string): string {
	return template.replace("{ticker}", tickerLower);
}

function stockDataUrl(template: string, ticker: string): string {
	const path = stockAnalysisStockPathForTicker(ticker);
	return template.replace("stocks/{ticker}", path).replace("{ticker}", ticker);
}

function sectorSlug(sectorName: string): string {
	return sectorName
		.trim()
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function sectorUrl(sectorName: string): string {
	return STOCKANALYSIS_SECTOR_URL.replace("{sector}", sectorSlug(sectorName));
}

function normalizeTickerSymbol(value: string): string {
	return value
		.trim()
		.toUpperCase()
		.replace(/^NYSE:/, "")
		.replace(/^NASDAQ:/, "")
		.replace(/^AMEX:/, "");
}

function normalizeTopTickers(values: string[]): string[] {
	const tickers: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const ticker = normalizeTickerSymbol(String(value || ""));
		if (!ticker || seen.has(ticker)) {
			continue;
		}
		seen.add(ticker);
		tickers.push(ticker);
		if (tickers.length >= SECTOR_TOP_TICKER_COUNT) {
			break;
		}
	}
	return tickers;
}

function parseSectorTopTickers(text: string): string[] {
	const topTickers: string[] = [];
	for (const line of text.split("\n")) {
		const rowMatch = line
			.trim()
			.match(/^\|\s*\d+\s*\|\s*([A-Za-z][A-Za-z0-9.-]*)\s*\|/);
		if (!rowMatch?.[1]) {
			continue;
		}
		topTickers.push(rowMatch[1]);
		if (topTickers.length >= SECTOR_TOP_TICKER_COUNT) {
			break;
		}
	}
	return normalizeTopTickers(topTickers);
}

function normalizeSectorRows(rows: SectorRow[]): StockAnalysisSectorSummary[] {
	return rows
		.map((sector) => ({
			...sector,
			top_tickers: [] as string[],
		}))
		.filter(
			(row): row is StockAnalysisSectorSummary =>
				!!row.sector && Number.isFinite(row.stock_count),
		);
}

function toSectorCacheRows(rows: StockAnalysisSectorSummary[]): SectorRow[] {
	return rows.map(
		({
			sector,
			stock_count,
			market_cap,
			pe,
			profit_margin,
			change_percent_1d,
			change_percent_1y,
		}) => ({
			sector,
			stock_count,
			market_cap,
			pe,
			profit_margin,
			change_percent_1d,
			change_percent_1y,
		}),
	);
}

async function loadSectorSnapshotCache(): Promise<SectorSnapshotCache> {
	return loadJsonCache(
		SECTOR_SNAPSHOT_CACHE_PATH,
		SectorSnapshotCacheSchema,
		() => ({ fetched_at: null, sectors: [] }),
	);
}

async function writeSectorSnapshotCache(
	cache: SectorSnapshotCache,
): Promise<void> {
	await writeJsonCache(SECTOR_SNAPSHOT_CACHE_PATH, cache);
}

async function loadSectorTopTickerCache(): Promise<SectorTopTickerCache> {
	return loadJsonCache(
		SECTOR_TOP_TICKER_CACHE_PATH,
		SectorTopTickerCacheSchema,
		() => ({ entries: {} }),
	);
}

async function writeSectorTopTickerCache(
	cache: SectorTopTickerCache,
): Promise<void> {
	await writeJsonCache(SECTOR_TOP_TICKER_CACHE_PATH, cache);
}

function readCachedSectorTopTickers(
	cache: SectorTopTickerCache,
	slug: string,
	now: Date,
): SectorTopTickerCacheMatch {
	const entry = cache.entries[slug];
	if (!entry?.tickers.length) {
		return { freshTickers: null, fallbackTickers: null };
	}

	const tickers = normalizeTopTickers(entry.tickers);
	if (tickers.length === 0) {
		return { freshTickers: null, fallbackTickers: null };
	}

	const isFresh = isCacheTimestampFresh(
		entry.fetched_at,
		now,
		SECTOR_TOP_TICKER_CACHE_TTL_MS,
	);
	return {
		freshTickers: isFresh ? tickers : null,
		fallbackTickers: tickers,
	};
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

function parseStockAnalysisNumber(
	value: string,
	defaultMultiplier = 1,
): number | null {
	const normalized = value.trim();
	if (!normalized || NULL_NUMBER_TEXTS.has(normalized.toLowerCase())) {
		return null;
	}
	const valueMatch = normalized
		.replace(/\u2212/g, "-")
		.match(/\(?\s*[$€£¥]?\s*(-?[\d,.]+(?:\.\d+)?)\s*([KMBT])?\s*%?\s*\)?/i);
	if (!valueMatch?.[1]) {
		return null;
	}
	const numberValue = Number(valueMatch[1].replace(/,/g, ""));
	if (!Number.isFinite(numberValue)) {
		return null;
	}
	const multiplier =
		NUMBER_SUFFIX_MULTIPLIERS[valueMatch[2]?.toUpperCase() ?? ""] ??
		defaultMultiplier;
	const sign =
		normalized.trim().startsWith("(") && normalized.trim().endsWith(")")
			? -1
			: 1;
	return sign * numberValue * multiplier;
}

function markdownTableCells(row: string): string[] {
	return row
		.split("|")
		.map((cell) => cell.trim())
		.filter(Boolean);
}

function normalizeStatisticLabel(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function statisticFieldForLabel(label: string): StatisticsFieldName | null {
	const normalizedLabel = normalizeStatisticLabel(label);
	if (STATISTICS_ROW_FIELDS[normalizedLabel]) {
		return STATISTICS_ROW_FIELDS[normalizedLabel];
	}
	const lowerLabel = normalizedLabel.toLowerCase();
	for (const [rowLabel, fieldName] of Object.entries(STATISTICS_ROW_FIELDS)) {
		const normalizedRowLabel = rowLabel.toLowerCase();
		if (lowerLabel === normalizedRowLabel) {
			return fieldName;
		}
	}
	return null;
}

function parseStatisticLine(
	line: string,
): [StatisticsFieldName, number] | null {
	const trimmedLine = line.trim();
	if (!trimmedLine || /^#+\s/.test(trimmedLine)) {
		return null;
	}

	if (trimmedLine.startsWith("|")) {
		const [label, value] = markdownTableCells(trimmedLine);
		const fieldName = label == null ? null : statisticFieldForLabel(label);
		const parsedValue = value == null ? null : parseStockAnalysisNumber(value);
		return fieldName != null && parsedValue != null
			? [fieldName, parsedValue]
			: null;
	}

	for (const label of Object.keys(STATISTICS_ROW_FIELDS)) {
		const pattern = new RegExp(
			`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(.+)$`,
			"i",
		);
		const match = trimmedLine.match(pattern);
		const fieldName = STATISTICS_ROW_FIELDS[label];
		const parsedValue = match?.[1] ? parseStockAnalysisNumber(match[1]) : null;
		if (fieldName != null && parsedValue != null) {
			return [fieldName, parsedValue];
		}
	}

	return null;
}

function parseStatisticsSnapshotFromText(
	text: string,
): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	for (const line of text.split(/\r?\n/)) {
		const parsedLine = parseStatisticLine(line);
		if (parsedLine == null) {
			continue;
		}
		const [fieldName, value] = parsedLine;
		output[fieldName] ??= value;
	}
	return output;
}

function firstMarkdownTableCell(row: string): string | null {
	const cells = markdownTableCells(row);
	return cells[0] ?? null;
}

function mergeParsedFields<T extends Record<string, unknown>>(
	parsedFields: Record<string, unknown>,
	fallbackFields: T,
): T {
	return {
		...fallbackFields,
		...parsedFields,
	};
}

function hasParsedStatisticsFields(fields: Record<string, unknown>): boolean {
	return PARSED_STATISTICS_REQUIRED_FIELDS.some(
		(fieldName) => fields[fieldName] != null,
	);
}

function financialsUnitMultiplier(text: string): number {
	const unitLine =
		text.split(/\r?\n/).find((line) => /Financials in .*USD/i.test(line)) ?? "";
	if (/thousands?\s+USD/i.test(unitLine)) {
		return 1e3;
	}
	if (/millions?\s+USD/i.test(unitLine)) {
		return 1e6;
	}
	if (/billions?\s+USD/i.test(unitLine)) {
		return 1e9;
	}
	return 1;
}

function financialsFieldMultiplier(
	fieldName: FinancialsFieldName,
	unitMultiplier: number,
): number {
	if (FINANCIALS_MONETARY_FIELDS.has(fieldName)) {
		return unitMultiplier;
	}
	return 1;
}

function financialsRowLabels(labelLines: string[]): string[] {
	const labels = ["Period Ending"];
	for (const line of labelLines) {
		if (
			line === "Revenue Growth (YoY)" &&
			labels[labels.length - 1] !== "Revenue"
		) {
			labels.push("Revenue");
		}
		labels.push(line);
	}
	return labels;
}

function firstFinancialsTableHeaderIndex(
	lines: string[],
	periodEndingIndex: number,
): number {
	return lines.findIndex(
		(line, index) =>
			index > periodEndingIndex &&
			line.startsWith("|") &&
			(lines[index + 1] ?? "").startsWith("| ---"),
	);
}

function parseFinancialsSnapshotFromText(
	text: string,
): Record<string, unknown> {
	const unitMultiplier = financialsUnitMultiplier(text);
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const periodEndingIndex = lines.indexOf("Period Ending");
	const tableHeaderIndex = firstFinancialsTableHeaderIndex(
		lines,
		periodEndingIndex,
	);
	if (
		periodEndingIndex < 0 ||
		tableHeaderIndex < 0 ||
		tableHeaderIndex <= periodEndingIndex
	) {
		return {};
	}

	const rowLabels = financialsRowLabels(
		lines.slice(periodEndingIndex + 1, tableHeaderIndex),
	);
	const tableRows = lines
		.slice(tableHeaderIndex + 2)
		.filter((line) => line.startsWith("|"));
	const output: Record<string, unknown> = {};

	for (const [rowIndex, label] of rowLabels.entries()) {
		const fieldName = FINANCIALS_ROW_FIELDS[label];
		if (fieldName == null) {
			continue;
		}
		const currentColumnValue = firstMarkdownTableCell(
			tableRows[rowIndex] ?? "",
		);
		if (currentColumnValue == null) {
			continue;
		}
		output[fieldName] = parseStockAnalysisNumber(
			currentColumnValue,
			financialsFieldMultiplier(fieldName, unitMultiplier),
		);
	}

	return output;
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

async function loadStockAnalysisText(
	url: string,
	maxCharacters = DEFAULT_CONTENT_OPTIONS.maxCharacters,
): Promise<string | null> {
	try {
		const agent = new ExaLoadAgent({
			contentOptions: {
				...DEFAULT_CONTENT_OPTIONS,
				maxCharacters,
			},
		});
		const { pages } = await agent.load(url);
		return pages[0]?.text ?? null;
	} catch {
		return null;
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

async function fetchSectorTopTickers(
	sectorNames: string[],
): Promise<Map<string, string[]>> {
	if (sectorNames.length === 0) {
		return new Map();
	}

	const agent = new ExaLoadAgent({
		contentOptions: {
			...DEFAULT_CONTENT_OPTIONS,
			maxCharacters: SECTOR_TOP_TICKER_PAGE_MAX_CHARACTERS,
		},
	});
	const { pages } = await agent.load(sectorNames.map(sectorUrl));
	const tickersBySlug = new Map<string, string[]>();
	for (const [index, sectorName] of sectorNames.entries()) {
		const page = pages[index];
		const slug = sectorSlug(sectorName);
		const tickers = parseSectorTopTickers(page?.text ?? "");
		if (slug && tickers.length > 0) {
			tickersBySlug.set(slug, tickers);
		}
	}
	return tickersBySlug;
}

async function fetchSectorRows(): Promise<StockAnalysisSectorSummary[]> {
	const output = await loadStockAnalysisPage({
		urls: STOCKANALYSIS_SECTORS_URL,
		outputSchema: SectorSnapshotSchema,
		instruction: [
			"Extract StockAnalysis sector summary rows from the supplied sectors page.",
			"Return every sector row visible in the supplied contents.",
			"Use stock_count as an integer count.",
			"Use market_cap as absolute dollars when displayed; otherwise null.",
			"Use profit_margin and displayed change_percent fields as 0-100 numeric values.",
		].join("\n"),
	});
	return normalizeSectorRows(output.sectors);
}

async function loadSectorRowsWithCache(): Promise<
	StockAnalysisSectorSummary[]
> {
	const now = new Date();
	const cache = await loadSectorSnapshotCache();
	const cachedRows = normalizeSectorRows(cache.sectors);
	if (
		cachedRows.length > 0 &&
		isCacheTimestampFresh(cache.fetched_at, now, SECTOR_SNAPSHOT_CACHE_TTL_MS)
	) {
		return cachedRows;
	}

	try {
		const fetchedRows = await fetchSectorRows();
		if (fetchedRows.length > 0) {
			await writeSectorSnapshotCache({
				fetched_at: now.toISOString(),
				sectors: toSectorCacheRows(fetchedRows),
			});
			return fetchedRows;
		}
	} catch {
		// Fall through to stale cache rows when live refresh is unavailable.
	}

	return cachedRows;
}

async function enrichSectorsWithTopTickers(
	sectors: StockAnalysisSectorSummary[],
): Promise<StockAnalysisSectorSummary[]> {
	const now = new Date();
	const cache = await loadSectorTopTickerCache();
	const tickersBySlug = new Map<string, string[]>();
	const staleTickersBySlug = new Map<string, string[]>();
	const missingSectorNames: string[] = [];

	for (const sector of sectors) {
		const slug = sectorSlug(sector.sector);
		const cachedTickers = readCachedSectorTopTickers(cache, slug, now);
		if (cachedTickers.freshTickers) {
			tickersBySlug.set(slug, cachedTickers.freshTickers);
			continue;
		}
		if (cachedTickers.fallbackTickers) {
			staleTickersBySlug.set(slug, cachedTickers.fallbackTickers);
		}
		missingSectorNames.push(sector.sector);
	}

	const fetchedTickersBySlug = await fetchSectorTopTickers(missingSectorNames);
	const fetchedAt = now.toISOString();
	let cacheChanged = false;
	for (const [slug, tickers] of fetchedTickersBySlug) {
		cache.entries[slug] = { fetched_at: fetchedAt, tickers };
		tickersBySlug.set(slug, tickers);
		cacheChanged = true;
	}

	if (cacheChanged) {
		await writeSectorTopTickerCache(cache);
	}

	return sectors.map((sector) => ({
		...sector,
		top_tickers:
			tickersBySlug.get(sectorSlug(sector.sector)) ??
			staleTickersBySlug.get(sectorSlug(sector.sector)) ??
			[],
	}));
}

/** Load quote fields from a StockAnalysis overview page. */
export async function loadQuoteFields(
	tickerLower: string,
): Promise<Required<QuoteFields>> {
	const url = stockDataUrl(STOCKANALYSIS_OVERVIEW_URL, tickerLower);
	const output = await loadStockAnalysisPageOrDefault({
		urls: url,
		outputSchema: QuoteFieldsSchema,
		defaultValue: {
			price: null,
			change: null,
			change_percent_1d: null,
		},
		instruction: [
			`Extract current quote header fields for ${tickerLower.toUpperCase()} from the supplied StockAnalysis overview page.`,
			"Return the current price, absolute one-day change, and one-day change percentage if explicitly displayed.",
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
	const url = stockDataUrl(STOCKANALYSIS_STATISTICS_URL, tickerLower);
	const statisticsText = await loadStockAnalysisText(url);
	const parsedStatistics =
		statisticsText == null
			? {}
			: parseStatisticsSnapshotFromText(statisticsText);
	if (hasParsedStatisticsFields(parsedStatistics)) {
		return parsedStatistics;
	}

	const fallbackStatistics = await loadStockAnalysisPageOrDefault({
		urls: url,
		outputSchema: StatisticsSchema,
		defaultValue: {},
		instruction: [
			`Extract the StockAnalysis statistics schema for ${tickerLower.toUpperCase()}.`,
			`Source URL: ${url}`,
			"Use market_cap, revenue, and free_cash_flow as absolute dollar values.",
			"Use pe, pe_forward, ps, peg, beta, roe, roic, debt_to_equity, and debt_to_ebitda as displayed numeric ratios.",
			"Use ps_forward only for an explicitly displayed Forward P/S or Forward Price/Sales ratio; otherwise return null.",
			"Use gross_margin, operating_margin, shareholder_yield, rsi, median_upside, and price-change fields as 0-100 numeric values.",
			"If analyst consensus and price-target fields are visible, return one ratings row with firm 'Consensus'.",
		].join("\n"),
	});
	return mergeParsedFields(parsedStatistics, fallbackStatistics);
}

/** Load the StockAnalysis financials page into the app financials shape. */
export async function loadFinancialsSnapshot(
	tickerLower: string,
): Promise<Record<string, unknown>> {
	const url = stockDataUrl(STOCKANALYSIS_FINANCIALS_URL, tickerLower);
	const financialsText = await loadStockAnalysisText(url);
	const parsedFinancials =
		financialsText == null
			? {}
			: parseFinancialsSnapshotFromText(financialsText);
	if (Object.keys(parsedFinancials).length > 0) {
		return parsedFinancials;
	}
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
			"eps_growth must come from the EPS Growth row only; do not use EPS (Diluted), EPS (Basic), or Shares Change (YoY).",
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

/** Load sector summary rows from StockAnalysis. */
export async function loadSectorSnapshot(): Promise<StockAnalysisSectorSnapshot> {
	const sectors = await loadSectorRowsWithCache();
	const enrichedSectors = await enrichSectorsWithTopTickers(sectors);
	return {
		sectors: enrichedSectors,
		meta: {
			source: "stockanalysis-sectors",
			fetched_at: enrichedSectors.length > 0 ? new Date().toISOString() : null,
			sector_count: new Set(enrichedSectors.map((row) => row.sector)).size,
		},
	};
}
