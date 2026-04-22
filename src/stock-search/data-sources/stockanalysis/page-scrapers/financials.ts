/** StockAnalysis financials page scraping helpers. */

import type { StockAnalysisFinancialsPayload } from "../parsing.js";
import { STOCKANALYSIS_FINANCIALS_URL } from "../urls.js";
import {
	evaluateObjectLiteral,
	extractObjectLiteral,
	fetchText,
	toPercent,
} from "../../shared.js";

/** Scrape the StockAnalysis financials page into a structured snapshot. */
export async function scrapeFinancialsSnapshot(
	tickerLower: string,
): Promise<Record<string, unknown>> {
	const html = await fetchText(
		STOCKANALYSIS_FINANCIALS_URL.replace("{ticker}", tickerLower),
	);
	const payload = evaluateObjectLiteral<StockAnalysisFinancialsPayload>(
		extractObjectLiteral(html ?? "", "financialData"),
	);
	if (!payload) {
		return {};
	}

	return {
		revenue_growth: toPercent(payload.revenueGrowth?.[0] ?? null),
		eps_growth: toPercent(payload.epsGrowth?.[0] ?? null),
		gross_margin: toPercent(payload.grossMargin?.[0] ?? null),
	};
}
