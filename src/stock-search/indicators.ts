/** Compatibility wrappers over the dedicated backend data-source adapters. */

import { FinvizSource } from "./data-sources/finviz/index.js";
import { StockAnalysisSource } from "./data-sources/stockanalysis/index.js";
import { YahooFinanceSource } from "./data-sources/yahoo-finance.js";
import {
	mergeStockAnalysisSnapshots,
	normalizeMonetaryFields,
} from "./monetary-fields.js";
import {
	applySourcePegFallback,
	PEG_SOURCE_FINVIZ,
	PEG_SOURCE_STOCKANALYSIS,
} from "./stats-resolver/derived-stats.js";
import {
	mergeSourceFields,
	SAME_DEFINITION_BLEND_FIELDS,
	SOURCE_CACHE,
	SOURCE_FINVIZ,
	SOURCE_STOCKANALYSIS,
	SOURCE_YAHOO,
	sourceFieldPolicies,
} from "./stats-resolver/source-merge.js";
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
	"revenue",
	"pe",
	"pe_forward",
	"ps",
	"ps_forward",
	"peg",
	"beta",
	"roe",
	"roic",
	"debt_to_equity",
	"free_cash_flow",
	"shareholder_yield",
	"rsi",
	"eps_this_y_growth",
	"eps_next_y_growth",
	"eps_next_5y_growth",
	"eps_past_3y_growth",
	"eps_past_5y_growth",
	"sales_past_3y_growth",
	"sales_past_5y_growth",
	"eps_yoy_ttm_growth",
]);
const FINANCIALS_PRIORITY_FIELDS = new Set([
	"revenue_growth",
	"eps_growth",
	"gross_margin",
	"operating_margin",
]);
const FX_SOURCE_FIELDS = new Set(["market_cap", "free_cash_flow"]);
const LIVE_FIELD_POLICIES = sourceFieldPolicies(
	{
		fields: YAHOO_PRIORITY_FIELDS,
		mode: "first",
		sources: [SOURCE_YAHOO, SOURCE_STOCKANALYSIS, SOURCE_CACHE],
	},
	{
		fields: ["revenue"],
		mode: "mean",
		sources: [SOURCE_STOCKANALYSIS, SOURCE_FINVIZ],
		fallbackSources: [SOURCE_CACHE],
	},
	{
		fields: SAME_DEFINITION_BLEND_FIELDS,
		mode: "mean",
		sources: [SOURCE_STOCKANALYSIS, SOURCE_FINVIZ],
		fallbackSources: [SOURCE_CACHE, SOURCE_YAHOO],
	},
	{
		fields: new Set([
			...STATISTICS_PRIORITY_FIELDS,
			...FINANCIALS_PRIORITY_FIELDS,
		]),
		mode: "first",
		sources: [SOURCE_STOCKANALYSIS, SOURCE_FINVIZ, SOURCE_CACHE, SOURCE_YAHOO],
	},
);

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

/** Fetch Finviz statistics fields for one ticker through the throttled queue. */
export async function fetchFinvizStatistics(
	ticker: string,
): Promise<Record<string, unknown>> {
	return new FinvizSource(ticker).getStatisticsSnapshot();
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
		finvizStatistics,
		stockAnalysisFinancials,
		yahooSymbolMetadata,
	] = await Promise.all([
		fetchYahooIndicators(ticker),
		fetchStockAnalysisStatistics(ticker),
		fetchFinvizStatistics(ticker).catch((): Record<string, unknown> => ({})),
		fetchStockAnalysisFinancials(ticker),
		fetchYahooSymbolMetadata(ticker),
	]);

	const yahooPayload = {
		...yahooFields,
		...yahooSymbolMetadata,
	};
	const stockAnalysisPayload: Record<string, unknown> = {
		...mergeStockAnalysisSnapshots(
			stockAnalysisStatistics,
			stockAnalysisFinancials,
		),
		revenue_growth: stockAnalysisFinancials.revenue_growth ?? null,
		eps_growth: stockAnalysisFinancials.eps_growth ?? null,
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

	const liveFields = mergeSourceFields({
		fields: new Set([
			...Object.keys(cachedIndicators),
			...Object.keys(yahooPayload),
			...Object.keys(stockAnalysisPayload),
			...Object.keys(finvizStatistics),
		]),
		sources: [
			{ source: SOURCE_CACHE, fields: cachedIndicators },
			{ source: SOURCE_YAHOO, fields: yahooPayload },
			{ source: SOURCE_STOCKANALYSIS, fields: stockAnalysisPayload },
			{ source: SOURCE_FINVIZ, fields: finvizStatistics },
		],
		policies: LIVE_FIELD_POLICIES,
	});

	if (yahooPayload.fx != null) {
		for (const field of FX_SOURCE_FIELDS) {
			liveFields[field] = yahooPayload[field] ?? null;
		}
	}

	normalizeMonetaryFields(liveFields);
	applySourcePegFallback(liveFields, [
		{
			source: PEG_SOURCE_STOCKANALYSIS,
			pe_forward: stockAnalysisPayload.pe_forward,
			peg: stockAnalysisPayload.peg,
		},
		{
			source: PEG_SOURCE_FINVIZ,
			pe_forward: finvizStatistics.pe_forward,
			peg: finvizStatistics.peg,
		},
	]);

	const hasLiveField = Object.values(liveFields).some(
		(value) => value !== null && value !== undefined,
	);
	if (!hasLiveField) {
		throw new Error(`Live stats unavailable for ticker: ${ticker}`);
	}

	return liveFields;
}
