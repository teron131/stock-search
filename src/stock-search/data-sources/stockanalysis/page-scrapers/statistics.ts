/** StockAnalysis statistics page scraping helpers. */

import {
	entryValue,
	flattenStatisticsEntries,
	type StockAnalysisStatisticsPayload,
} from "../parsing.js";
import { STOCKANALYSIS_STATISTICS_URL } from "../urls.js";
import {
	evaluateObjectLiteral,
	extractObjectLiteral,
	fetchText,
	parseNumberText,
} from "../../shared.js";

const QUOTE_BLOCK_PATTERN = /quote:\{(.*?)\},stream:/s;
const QUOTE_EMPTY_FIELDS = {
	price: null,
	change: null,
	change_percent_1d: null,
};
const REGULAR_QUOTE_KEYS = {
	price: "p",
	change: "c",
	change_percent_1d: "cp",
} as const;
const EXTENDED_QUOTE_KEYS = {
	price: "ep",
	change: "ec",
	change_percent_1d: "ecp",
} as const;
const EXTENDED_SESSION_NAMES = new Set(["Pre-market", "After-hours"]);

function extractQuoteScalar(quoteBlock: string, key: string): string | null {
	const match = quoteBlock.match(new RegExp(`${key}:("([^"]*)"|[^,}]+)`));
	if (!match) {
		return null;
	}
	const rawValue = match[2] ?? match[1] ?? "";
	return String(rawValue).replace(/^"|"$/g, "").trim() || null;
}

function extractQuoteValues(
	quoteBlock: string,
	fieldKeys: Record<keyof typeof QUOTE_EMPTY_FIELDS, string>,
): Record<keyof typeof QUOTE_EMPTY_FIELDS, number | null> {
	return {
		price: parseNumberText(extractQuoteScalar(quoteBlock, fieldKeys.price)),
		change: parseNumberText(extractQuoteScalar(quoteBlock, fieldKeys.change)),
		change_percent_1d: parseNumberText(
			extractQuoteScalar(quoteBlock, fieldKeys.change_percent_1d),
		),
	};
}

/** Scrape the StockAnalysis statistics page into a structured snapshot. */
export async function scrapeStatisticsSnapshot(
	tickerLower: string,
): Promise<Record<string, unknown>> {
	const html = await fetchText(
		STOCKANALYSIS_STATISTICS_URL.replace("{ticker}", tickerLower),
	);
	const payload = evaluateObjectLiteral<StockAnalysisStatisticsPayload>(
		extractObjectLiteral(html ?? "", "statistics"),
	);
	const entries = flattenStatisticsEntries(payload);
	if (entries.size === 0) {
		return {};
	}

	const medianUpside = entryValue(entries, "priceTargetChange");
	const priceTarget = entryValue(entries, "priceTarget");
	const analystConsensus = entries.get("analystRatings")?.value;
	const analystCount = entryValue(entries, "analystCount");

	return {
		market_cap: entryValue(entries, "marketCap"),
		pe: entryValue(entries, "pe"),
		pe_forward: entryValue(entries, "peForward"),
		peg: entryValue(entries, "pegRatio"),
		beta: entryValue(entries, "beta"),
		free_cash_flow: entryValue(entries, "fcf"),
		gross_margin: entryValue(entries, "grossMargin"),
		debt_to_equity: entryValue(entries, "debtEquity"),
		rsi: entryValue(entries, "rsi"),
		median_upside: medianUpside,
		ratings:
			medianUpside != null || priceTarget != null || analystConsensus != null
				? [
						{
							firm: "Consensus",
							to_grade: analystConsensus ?? null,
							from_grade: null,
							action: "consensus",
							date: null,
							analyst_count: analystCount,
							price_target: priceTarget,
							upside_pct: medianUpside,
						},
					]
		: null,
	};
}

/** Extract quote fields embedded on the statistics page. */
export async function scrapeQuoteFields(
	tickerLower: string,
): Promise<Record<keyof typeof QUOTE_EMPTY_FIELDS, number | null>> {
	const html = await fetchText(
		STOCKANALYSIS_STATISTICS_URL.replace("{ticker}", tickerLower),
	);
	const quoteBlock = html?.match(QUOTE_BLOCK_PATTERN)?.[1];
	if (!quoteBlock) {
		return { ...QUOTE_EMPTY_FIELDS };
	}

	const regularQuote = extractQuoteValues(quoteBlock, REGULAR_QUOTE_KEYS);
	const extendedQuote = extractQuoteValues(quoteBlock, EXTENDED_QUOTE_KEYS);
	const extendedSession = extractQuoteScalar(quoteBlock, "es");

	if (
		extendedSession &&
		EXTENDED_SESSION_NAMES.has(extendedSession) &&
		extendedQuote.price != null
	) {
		return extendedQuote;
	}
	return regularQuote;
}
