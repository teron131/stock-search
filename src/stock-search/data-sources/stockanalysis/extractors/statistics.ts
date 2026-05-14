/** Statistics extraction from StockAnalysis statistics pages. */

import { z } from "zod";

import { getFieldDescription } from "../../../models/field-definitions.js";
import {
	loadStockAnalysisPageOrDefault,
	loadStockAnalysisText,
} from "./exa-client.js";
import { markdownTableCells, parseStockAnalysisNumber } from "./parsing.js";
import {
	STOCKANALYSIS_OVERVIEW_URL,
	STOCKANALYSIS_STATISTICS_URL,
	stockDataUrl,
} from "./urls.js";

const PARSED_STATISTICS_REQUIRED_FIELDS = [
	"market_cap",
	"revenue",
	"pe",
	"pe_forward",
	"ps",
	"peg",
] as const satisfies readonly StatisticsFieldName[];

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

const STATISTICS_ROW_FIELDS: Record<string, StatisticsFieldName> = {
	"Market Cap": "market_cap",
	"Revenue (ttm)": "revenue",
	Revenue: "revenue",
	Beta: "beta",
	"Beta (5Y)": "beta",
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

type QuoteFields = z.output<typeof QuoteFieldsSchema>;

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

function hasParsedStatisticsFields(fields: Record<string, unknown>): boolean {
	return PARSED_STATISTICS_REQUIRED_FIELDS.some(
		(fieldName) => fields[fieldName] != null,
	);
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
	return {
		...fallbackStatistics,
		...parsedStatistics,
	};
}
