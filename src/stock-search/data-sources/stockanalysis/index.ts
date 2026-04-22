/** StockAnalysis source adapter package. */

export {
	StockAnalysisSource,
	getIndustrySnapshot,
} from "./adapter.js";
export {
	invokeStockanalysisSearch,
	invokeStockanalysisSearchOrDefault,
} from "./exa-fallback.js";
export type {
	StockAnalysisEtfSnapshot,
	StockAnalysisFinancials,
	StockAnalysisIndicatorsSnapshot,
	StockAnalysisIndustrySnapshot,
	StockAnalysisIndustrySummary,
	StockAnalysisStatistics,
} from "./schemas.js";
export {
	ETF_HOLDINGS_SEARCH_SYSTEM_PROMPT,
	ETF_SECTOR_SEARCH_SYSTEM_PROMPT,
	FINANCIALS_SYSTEM_PROMPT,
	STATISTICS_SYSTEM_PROMPT,
} from "./prompts.js";
