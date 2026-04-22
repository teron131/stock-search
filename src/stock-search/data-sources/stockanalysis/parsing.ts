/** Pure parsing helpers for StockAnalysis page content. */

import { normalizeTicker } from "../../utils.js";
import { parseNumberText } from "../shared.js";

const HOLDINGS_BLOCK_PATTERN = /holdings:\[(.*?)\],asset_allocation:/s;
const HOLDING_ROW_PATTERN =
	/\{[^{}]*n:"([^"]+)"[^{}]*s:"([^"]+)"[^{}]*as:"([\d.]+)%"/g;
const SECTORS_BLOCK_PATTERN = /sectors:\[(.*?)\],(?:countries|allocationChartData):/s;
const SECTOR_ROW_PATTERN = /\{n:"([^"]+)",w:([\d.]+)\}/g;

type StockAnalysisEntry = {
	id?: string;
	value?: string | number | null;
	hover?: string | number | null;
};

type StockAnalysisSection = {
	data?: StockAnalysisEntry[];
};

export type StockAnalysisStatisticsPayload = Record<string, StockAnalysisSection>;

export type StockAnalysisFinancialsPayload = {
	revenueGrowth?: number[];
	epsGrowth?: number[];
	grossMargin?: number[];
};

export function cleanSymbol(rawSymbol: string): string {
	const symbol = rawSymbol.trim();
	if (symbol.startsWith("$")) {
		return symbol.slice(1);
	}
	if (symbol.startsWith("!") && symbol.includes("/")) {
		return symbol.split("/", 2)[1];
	}
	if (symbol.startsWith("!")) {
		return symbol.slice(1);
	}
	return symbol;
}

/** Flatten the nested StockAnalysis statistics object into one id map. */
export function flattenStatisticsEntries(
	payload: StockAnalysisStatisticsPayload | null,
): Map<string, StockAnalysisEntry> {
	const entries = new Map<string, StockAnalysisEntry>();
	if (!payload) {
		return entries;
	}

	for (const section of Object.values(payload)) {
		if (!Array.isArray(section?.data)) {
			continue;
		}
		for (const entry of section.data) {
			const id = String(entry?.id ?? "").trim();
			if (!id) {
				continue;
			}
			entries.set(id, entry);
		}
	}

	return entries;
}

/** Read one numeric field by entry id from a flattened StockAnalysis map. */
export function entryValue(
	entries: Map<string, StockAnalysisEntry>,
	id: string,
): number | null {
	const entry = entries.get(id);
	return parseNumberText(entry?.hover ?? entry?.value ?? null);
}

/** Parse embedded ETF holdings rows from a StockAnalysis holdings page. */
export function parseEtfHoldings(html: string): Array<{
	ticker: string;
	name: string | null;
	weight: number;
}> {
	const holdingsBlock = html.match(HOLDINGS_BLOCK_PATTERN)?.[1] ?? "";
	return [...holdingsBlock.matchAll(HOLDING_ROW_PATTERN)]
		.map((match) => ({
			ticker: normalizeTicker(cleanSymbol(match[2] ?? "")),
			name: (match[1] ?? "").trim() || null,
			weight: Number(match[3]),
		}))
		.filter((holding) => holding.ticker && Number.isFinite(holding.weight));
}

/** Parse embedded ETF sector rows from a StockAnalysis holdings page. */
export function parseEtfSectors(html: string): Array<{
	name: string;
	weight: number;
}> {
	const sectorsBlock = html.match(SECTORS_BLOCK_PATTERN)?.[1] ?? "";
	return [...sectorsBlock.matchAll(SECTOR_ROW_PATTERN)]
		.map((match) => ({
			name: String(match[1] ?? "").trim(),
			weight: Number(match[2]),
		}))
		.filter((sector) => sector.name && Number.isFinite(sector.weight));
}
