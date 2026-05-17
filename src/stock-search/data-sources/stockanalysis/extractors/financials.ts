/** Financial table extraction from StockAnalysis financials pages. */

import { z } from "zod";

import { getFieldDescription } from "../../../models/field-definitions.js";
import {
	loadStockAnalysisPageOrDefault,
	loadStockAnalysisText,
} from "./exa-client.js";
import { markdownTableCells, parseStockAnalysisNumber } from "./parsing.js";
import { STOCKANALYSIS_FINANCIALS_URL, stockDataUrl } from "./urls.js";

const NullableNumber = z
	.number()
	.nullable()
	.describe("Numeric value extracted from StockAnalysis, or null if absent.");

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
		financials_currency: z
			.string()
			.nullable()
			.optional()
			.describe(
				"Currency code shown in the StockAnalysis financials unit label.",
			),
		research_and_development: NullableNumber.optional().describe(
			"Research and development expense from the first/current column, converted to absolute dollars using the page unit label.",
		),
		revenue_growth_1y: NullableNumber.optional().describe(
			"Revenue growth between the latest and prior fiscal-year columns.",
		),
		revenue_cagr_3y: NullableNumber.optional().describe(
			"Revenue CAGR between the latest fiscal-year column and the fiscal-year column three years earlier.",
		),
		fcf_growth_1y: NullableNumber.optional().describe(
			"Free cash flow growth between the latest and prior fiscal-year columns.",
		),
		fcf_cagr_3y: NullableNumber.optional().describe(
			"Free cash flow CAGR between the latest fiscal-year column and the fiscal-year column three years earlier.",
		),
		gross_margin_median_3y: NullableNumber.optional().describe(
			"Median gross margin across the latest three fiscal-year columns.",
		),
		operating_margin_median_3y: NullableNumber.optional().describe(
			"Median operating margin across the latest three fiscal-year columns.",
		),
		operating_margin_delta_vs_3y: NullableNumber.optional().describe(
			"Latest fiscal-year operating margin minus the latest-three-year median operating margin.",
		),
		operating_margin_std_3y: NullableNumber.optional().describe(
			"Standard deviation of operating margin across the latest three fiscal-year columns.",
		),
		fcf_margin_median_3y: NullableNumber.optional().describe(
			"Median FCF margin across the latest three fiscal-year columns.",
		),
		shares_change_1y: NullableNumber.optional().describe(
			"Shares Change (YoY) from the latest fiscal-year column.",
		),
		shares_change_cagr_3y: NullableNumber.optional().describe(
			"Shares outstanding CAGR between the latest fiscal-year column and the fiscal-year column three years earlier.",
		),
		rd_intensity: NullableNumber.optional().describe(
			"Latest fiscal-year R&D expense divided by latest fiscal-year revenue, in percent.",
		),
		rd_knowledge_capital: NullableNumber.optional().describe(
			"Weighted R&D knowledge-capital proxy using the latest and prior fiscal-year R&D rows.",
		),
	})
	.describe(
		"Income statement fields extracted from the StockAnalysis financials page.",
	);

type FinancialsFieldName =
	| "revenue"
	| "revenue_growth"
	| "eps_diluted"
	| "eps_growth"
	| "gross_margin"
	| "operating_margin"
	| "free_cash_flow"
	| "financials_currency"
	| "research_and_development"
	| "revenue_growth_1y"
	| "revenue_cagr_3y"
	| "fcf_growth_1y"
	| "fcf_cagr_3y"
	| "gross_margin_median_3y"
	| "operating_margin_median_3y"
	| "operating_margin_delta_vs_3y"
	| "operating_margin_std_3y"
	| "fcf_margin_median_3y"
	| "shares_change_1y"
	| "shares_change_cagr_3y"
	| "rd_intensity"
	| "rd_knowledge_capital";

const FINANCIALS_ROW_FIELDS: Record<string, FinancialsFieldName> = {
	Revenue: "revenue",
	"Total Revenue": "revenue",
	"Revenues Before Loan Losses": "revenue",
	"Revenue Growth (YoY)": "revenue_growth",
	"EPS (Diluted)": "eps_diluted",
	"EPS Growth": "eps_growth",
	"Gross Margin": "gross_margin",
	"Operating Margin": "operating_margin",
	"Research & Development": "research_and_development",
	"Free Cash Flow": "free_cash_flow",
};

const FINANCIALS_MONETARY_FIELDS = new Set<FinancialsFieldName>([
	"revenue",
	"research_and_development",
	"free_cash_flow",
]);

function financialsUnitLine(text: string): string {
	return text.split(/\r?\n/).find((line) => /Financials in /i.test(line)) ?? "";
}

function financialsUnitCurrency(text: string): string | null {
	const match = financialsUnitLine(text).match(
		/Financials in (?:thousands?|millions?|billions?)\s+([A-Z]{3})/i,
	);
	return match?.[1]?.toUpperCase() ?? null;
}

function financialsUnitMultiplier(text: string): number {
	const unitLine = financialsUnitLine(text);
	if (/thousands?\s+USD/i.test(unitLine)) {
		return 1e3;
	}
	if (/millions?\s+USD/i.test(unitLine)) {
		return 1e6;
	}
	if (/billions?\s+USD/i.test(unitLine)) {
		return 1e9;
	}
	if (/thousands?/i.test(unitLine)) {
		return 1e3;
	}
	if (/millions?/i.test(unitLine)) {
		return 1e6;
	}
	if (/billions?/i.test(unitLine)) {
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

type FinancialsTable = {
	currency: string | null;
	header: string[];
	rowByLabel: Map<string, string[]>;
	unitMultiplier: number;
};

function parseFinancialsTable(text: string): FinancialsTable | null {
	const unitMultiplier = financialsUnitMultiplier(text);
	const currency = financialsUnitCurrency(text);
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const periodEndingIndex = lines.indexOf("Period Ending");
	const tableHeaderIndex = lines.findIndex(
		(line, index) =>
			index > periodEndingIndex &&
			line.startsWith("|") &&
			(lines[index + 1] ?? "").startsWith("| ---"),
	);
	if (
		periodEndingIndex < 0 ||
		tableHeaderIndex < 0 ||
		tableHeaderIndex <= periodEndingIndex
	) {
		return null;
	}

	const rowLabels = financialsRowLabels(
		lines.slice(periodEndingIndex + 1, tableHeaderIndex),
	);
	const tableRows = lines
		.slice(tableHeaderIndex)
		.filter((line) => line.startsWith("|"));
	const header = markdownTableCells(tableRows[0] ?? "");
	const dataRows = tableRows.slice(2);
	const rowByLabel = new Map<string, string[]>();
	for (const [rowIndex, label] of rowLabels.entries()) {
		const row = markdownTableCells(dataRows[rowIndex] ?? "");
		if (row.length > 0) {
			rowByLabel.set(label, row);
		}
	}

	return { currency, header, rowByLabel, unitMultiplier };
}

function financialsTableValue(
	table: FinancialsTable,
	label: string,
	columnIndex: number,
	fieldName: FinancialsFieldName,
): number | null {
	const value = table.rowByLabel.get(label)?.[columnIndex];
	return value == null
		? null
		: parseStockAnalysisNumber(
				value,
				financialsFieldMultiplier(fieldName, table.unitMultiplier),
			);
}

function percentChange(
	currentValue: number | null,
	priorValue: number | null,
): number | null {
	if (
		currentValue == null ||
		priorValue == null ||
		priorValue === 0 ||
		!Number.isFinite(currentValue) ||
		!Number.isFinite(priorValue)
	) {
		return null;
	}
	return ((currentValue - priorValue) / Math.abs(priorValue)) * 100;
}

function cagrPercent(
	currentValue: number | null,
	priorValue: number | null,
	years: number,
): number | null {
	if (
		currentValue == null ||
		priorValue == null ||
		currentValue <= 0 ||
		priorValue <= 0 ||
		years <= 0
	) {
		return null;
	}
	return (currentValue / priorValue) ** (1 / years) * 100 - 100;
}

function median(values: number[]): number | null {
	if (values.length === 0) {
		return null;
	}
	const sortedValues = [...values].sort((left, right) => left - right);
	const midIndex = Math.floor(sortedValues.length / 2);
	return sortedValues.length % 2 === 0
		? (sortedValues[midIndex - 1] + sortedValues[midIndex]) / 2
		: sortedValues[midIndex];
}

function standardDeviation(values: number[]): number | null {
	if (values.length < 2) {
		return null;
	}
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	const variance =
		values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
	return Math.sqrt(variance);
}

function finiteValues(values: Array<number | null>): number[] {
	return values.filter((value): value is number => value != null);
}

function roundTrendValue(value: number | null): number | null {
	return value == null || !Number.isFinite(value)
		? null
		: Number(value.toFixed(2));
}

function deriveFinancialTrendFields(
	table: FinancialsTable,
): Record<string, unknown> {
	const fiscalColumns = table.header
		.map((label, index) => (label.startsWith("FY ") ? index : null))
		.filter((index): index is number => index != null);
	if (fiscalColumns.length === 0) {
		return {};
	}

	const latestIndex = fiscalColumns[0];
	const priorIndex = fiscalColumns[1];
	const threeYearBaseIndex = fiscalColumns[3];
	const tableValue = (
		label: string,
		columnIndex: number | undefined,
		fieldName: FinancialsFieldName,
	): number | null =>
		columnIndex == null
			? null
			: financialsTableValue(table, label, columnIndex, fieldName);

	const latestRevenue = tableValue("Revenue", latestIndex, "revenue");
	const priorRevenue = tableValue("Revenue", priorIndex, "revenue");
	const threeYearBaseRevenue = tableValue(
		"Revenue",
		threeYearBaseIndex,
		"revenue",
	);
	const latestFcf = tableValue("Free Cash Flow", latestIndex, "free_cash_flow");
	const priorFcf = tableValue("Free Cash Flow", priorIndex, "free_cash_flow");
	const threeYearBaseFcf = tableValue(
		"Free Cash Flow",
		threeYearBaseIndex,
		"free_cash_flow",
	);
	const latestRd = tableValue(
		"Research & Development",
		latestIndex,
		"research_and_development",
	);
	const rdValues = fiscalColumns
		.slice(0, 4)
		.map((columnIndex) =>
			tableValue(
				"Research & Development",
				columnIndex,
				"research_and_development",
			),
		);
	const marginColumnIndexes = fiscalColumns.slice(0, 3);
	const grossMargins = finiteValues(
		marginColumnIndexes.map((columnIndex) =>
			tableValue("Gross Margin", columnIndex, "gross_margin"),
		),
	);
	const operatingMargins = finiteValues(
		marginColumnIndexes.map((columnIndex) =>
			tableValue("Operating Margin", columnIndex, "operating_margin"),
		),
	);
	const fcfMargins = finiteValues(
		marginColumnIndexes.map((columnIndex) =>
			tableValue("FCF Margin", columnIndex, "fcf_margin_median_3y"),
		),
	);
	const latestOperatingMargin = operatingMargins[0] ?? null;
	const operatingMarginMedian = median(operatingMargins);
	const sharesChange = tableValue(
		"Shares Change (YoY)",
		latestIndex,
		"shares_change_1y",
	);
	const latestSharesOutstanding = tableValue(
		"Shares Outstanding",
		latestIndex,
		"shares_change_cagr_3y",
	);
	const threeYearBaseSharesOutstanding = tableValue(
		"Shares Outstanding",
		threeYearBaseIndex,
		"shares_change_cagr_3y",
	);
	const knowledgeCapitalWeights = [1, 0.75, 0.5, 0.25];
	const rdKnowledgeCapital = rdValues.reduce<number | null>(
		(sum, value, index) =>
			value == null
				? sum
				: (sum ?? 0) + value * (knowledgeCapitalWeights[index] ?? 0),
		null,
	);

	return {
		financials_currency: table.currency,
		revenue_growth_1y: roundTrendValue(
			percentChange(latestRevenue, priorRevenue),
		),
		revenue_cagr_3y: roundTrendValue(
			cagrPercent(latestRevenue, threeYearBaseRevenue, 3),
		),
		fcf_growth_1y: roundTrendValue(percentChange(latestFcf, priorFcf)),
		fcf_cagr_3y: roundTrendValue(cagrPercent(latestFcf, threeYearBaseFcf, 3)),
		gross_margin_median_3y: roundTrendValue(median(grossMargins)),
		operating_margin_median_3y: roundTrendValue(operatingMarginMedian),
		operating_margin_delta_vs_3y: roundTrendValue(
			latestOperatingMargin != null && operatingMarginMedian != null
				? latestOperatingMargin - operatingMarginMedian
				: null,
		),
		operating_margin_std_3y: roundTrendValue(
			standardDeviation(operatingMargins),
		),
		fcf_margin_median_3y: roundTrendValue(median(fcfMargins)),
		shares_change_1y: roundTrendValue(sharesChange),
		shares_change_cagr_3y: roundTrendValue(
			cagrPercent(latestSharesOutstanding, threeYearBaseSharesOutstanding, 3),
		),
		rd_intensity: roundTrendValue(
			latestRd != null && latestRevenue != null && latestRevenue > 0
				? (latestRd / latestRevenue) * 100
				: null,
		),
		rd_knowledge_capital: roundTrendValue(rdKnowledgeCapital),
	};
}

function parseFinancialsSnapshotFromText(
	text: string,
): Record<string, unknown> {
	const financialsTable = parseFinancialsTable(text);
	if (financialsTable == null) {
		return {};
	}

	const output: Record<string, unknown> = {};
	for (const [label, row] of financialsTable.rowByLabel.entries()) {
		const fieldName = FINANCIALS_ROW_FIELDS[label];
		if (fieldName == null) {
			continue;
		}
		const currentColumnValue = row[0];
		if (currentColumnValue == null) {
			continue;
		}
		output[fieldName] = parseStockAnalysisNumber(
			currentColumnValue,
			financialsFieldMultiplier(fieldName, financialsTable.unitMultiplier),
		);
	}

	return {
		...output,
		...deriveFinancialTrendFields(financialsTable),
	};
}

/** Load the StockAnalysis financials page into the app financials shape. */
export async function loadFinancialsSnapshot(
	tickerLower: string,
): Promise<Record<string, unknown>> {
	const url = stockDataUrl(STOCKANALYSIS_FINANCIALS_URL, tickerLower);
	const maxCharacters = 60_000;
	const financialsText = await loadStockAnalysisText(url, maxCharacters);
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
		maxCharacters,
		instruction: [
			`Extract the StockAnalysis financials schema for ${tickerLower.toUpperCase()}.`,
			`Source URL: ${url}`,
			"Use the first/current fiscal-year column for current values like revenue, free_cash_flow, gross_margin, and operating_margin.",
			"Use older fiscal-year columns to compute 1Y growth, 3Y CAGR, and 3Y median fields when the table provides enough periods.",
			"Use revenue_growth, eps_growth, gross_margin, and operating_margin as 0-100 numeric values.",
			"Use fcf_growth_1y and fcf_cagr_3y from displayed Free Cash Flow growth rows when present; otherwise compute them from Free Cash Flow values when the sign makes the calculation meaningful.",
			"eps_growth must come from the EPS Growth row only; do not use EPS (Diluted), EPS (Basic), or Shares Change (YoY).",
		].join("\n"),
	});
}
