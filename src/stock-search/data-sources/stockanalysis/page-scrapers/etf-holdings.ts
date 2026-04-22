/** StockAnalysis ETF holdings page scraping helpers. */

import {
	parseEtfHoldings,
	parseEtfSectors,
} from "../parsing.js";
import { STOCKANALYSIS_ETF_HOLDINGS_URL } from "../urls.js";
import { fetchText } from "../../shared.js";

/** Scrape ETF holdings from the holdings page. */
export async function scrapeEtfHoldingsSnapshot(
	tickerLower: string,
): Promise<Array<{ ticker: string; name: string | null; weight: number }>> {
	const html = await fetchText(
		STOCKANALYSIS_ETF_HOLDINGS_URL.replace("{ticker}", tickerLower),
	);
	return html ? parseEtfHoldings(html) : [];
}

/** Scrape ETF sectors from the holdings page. */
export async function scrapeEtfSectorsSnapshot(
	tickerLower: string,
): Promise<Array<{ name: string; weight: number }>> {
	const html = await fetchText(
		STOCKANALYSIS_ETF_HOLDINGS_URL.replace("{ticker}", tickerLower),
	);
	return html ? parseEtfSectors(html) : [];
}
