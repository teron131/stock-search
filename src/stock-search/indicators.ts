/** Compatibility wrappers over the dedicated backend data-source adapters. */

import { StockAnalysisSource } from "./data-sources/stockanalysis/index.js";
import { YahooFinanceSource } from "./data-sources/yahoo-finance.js";
import { normalizeMonetaryFields } from "./monetary-fields.js";
import { normalizeTicker } from "./utils.js";

const YAHOO_PRIORITY_FIELDS = new Set([
	"price",
	"change",
	"change_percent_1d",
	"iv",
	"change_percent_1m",
	"change_percent_3m",
	"change_percent_6m",
	"change_percent_1y",
	"change_percent_mtd",
	"change_percent_ytd",
	"ratings",
	"median_upside",
	"name",
	"quote_type",
	"sector_name",
	"industry_name",
]);
const STATISTICS_PRIORITY_FIELDS = new Set([
	"market_cap",
	"fx",
	"pe",
	"pe_forward",
	"peg",
	"beta",
	"free_cash_flow",
	"rsi",
]);
const FINANCIALS_PRIORITY_FIELDS = new Set([
	"revenue_growth",
	"gross_margin",
	"operating_margin",
	"debt_to_equity",
]);
const FX_SOURCE_FIELDS = new Set(["market_cap", "free_cash_flow"]);

/** Fetch indicator-shaped Yahoo fields for one ticker. */
export async function fetchYahooIndicators(
	ticker: string,
): Promise<Record<string, unknown>> {
	return new YahooFinanceSource(ticker).getIndicatorsSnapshot();
}

/** Fetch Yahoo search metadata fields for one ticker. */
export async function fetchYahooSymbolMetadata(
	ticker: string,
): Promise<Record<string, unknown>> {
	return new YahooFinanceSource(ticker).getSymbolMetadataSnapshot();
}

/** Fetch StockAnalysis statistics fields for one ticker. */
export async function fetchStockAnalysisStatistics(
	ticker: string,
): Promise<Record<string, unknown>> {
	return new StockAnalysisSource(ticker).getStatisticsSnapshot();
}

/** Fetch StockAnalysis financial fields for one ticker. */
export async function fetchStockAnalysisFinancials(
	ticker: string,
): Promise<Record<string, unknown>> {
	return new StockAnalysisSource(ticker).getFinancialsSnapshot();
}

/** Fetch the merged live indicator payload used by the public API layer. */
export async function fetchLiveIndicators(
	tickerInput: string,
	cachedIndicators: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const ticker = normalizeTicker(tickerInput);
	if (!ticker) {
		throw new Error("Invalid ticker");
	}

	const [
		yahooFields,
		stockAnalysisStatistics,
		stockAnalysisFinancials,
		yahooSymbolMetadata,
	] = await Promise.all([
		fetchYahooIndicators(ticker),
		fetchStockAnalysisStatistics(ticker),
		fetchStockAnalysisFinancials(ticker),
		fetchYahooSymbolMetadata(ticker),
	]);

	const yahooPayload = {
		...yahooFields,
		...yahooSymbolMetadata,
	};
	const stockAnalysisPayload: Record<string, unknown> = {
		...stockAnalysisStatistics,
		...stockAnalysisFinancials,
		gross_margin:
			stockAnalysisFinancials.gross_margin ??
			stockAnalysisStatistics.gross_margin ??
			null,
		operating_margin:
			stockAnalysisFinancials.operating_margin ??
			stockAnalysisStatistics.operating_margin ??
			null,
		debt_to_equity: stockAnalysisStatistics.debt_to_equity ?? null,
	};

	function resolveField(field: string): unknown {
		const hasYahooFx =
			yahooPayload.fx !== null && yahooPayload.fx !== undefined;
		if (hasYahooFx && FX_SOURCE_FIELDS.has(field)) {
			return yahooPayload[field] ?? null;
		}
		const priorities = YAHOO_PRIORITY_FIELDS.has(field)
			? [yahooPayload, stockAnalysisPayload, cachedIndicators]
			: STATISTICS_PRIORITY_FIELDS.has(field) ||
					FINANCIALS_PRIORITY_FIELDS.has(field)
				? [stockAnalysisPayload, cachedIndicators, yahooPayload]
				: [cachedIndicators, stockAnalysisPayload, yahooPayload];

		for (const source of priorities) {
			const value = source[field];
			if (value !== null && value !== undefined) {
				return value;
			}
		}
		return null;
	}

	const liveFields = { ...cachedIndicators };
	for (const field of new Set([
		...Object.keys(yahooPayload),
		...Object.keys(stockAnalysisPayload),
	])) {
		liveFields[field] = resolveField(field);
	}
	normalizeMonetaryFields(liveFields);

	const hasLiveField = Object.values(liveFields).some(
		(value) => value !== null && value !== undefined,
	);
	if (!hasLiveField) {
		throw new Error(`Live stats unavailable for ticker: ${ticker}`);
	}

	return liveFields;
}
