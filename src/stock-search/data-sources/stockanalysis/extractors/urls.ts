/** Owns StockAnalysis URL construction for stock and ETF extractor modules. */

import { stockAnalysisStockPathForTicker } from "../../provider-symbols.js";

export const STOCKANALYSIS_OVERVIEW_URL =
	"https://stockanalysis.com/stocks/{ticker}/";
export const STOCKANALYSIS_STATISTICS_URL =
	"https://stockanalysis.com/stocks/{ticker}/statistics/";
export const STOCKANALYSIS_FINANCIALS_URL =
	"https://stockanalysis.com/stocks/{ticker}/financials/";
export const STOCKANALYSIS_ETF_HOLDINGS_URL =
	"https://stockanalysis.com/etf/{ticker}/holdings/";
export const STOCKANALYSIS_SECTORS_URL =
	"https://stockanalysis.com/stocks/industry/sectors/";
export const STOCKANALYSIS_SECTOR_URL =
	"https://stockanalysis.com/stocks/sector/{sector}/";

export function stockDataUrl(template: string, ticker: string): string {
	const stockPath = stockAnalysisStockPathForTicker(ticker);
	return template
		.replace("stocks/{ticker}", stockPath)
		.replace("{ticker}", ticker);
}
