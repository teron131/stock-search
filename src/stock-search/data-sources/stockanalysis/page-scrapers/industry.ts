/** StockAnalysis industries page scraping helpers. */

import type { StockAnalysisIndustrySnapshot } from "../schemas.js";
import {
	STOCKANALYSIS_INDUSTRY_AGGREGATION_URL,
	STOCKANALYSIS_INDUSTRY_ALL_URL,
	STOCKANALYSIS_INDUSTRY_URL,
} from "../urls.js";
import {
	evaluateObjectLiteral,
	extractObjectLiteral,
	fetchJson,
	fetchText,
	toFiniteNumber,
} from "../../shared.js";

type RawIndustryRow = {
	industry_name?: string;
	url?: string;
	stocks?: number;
	marketCap?: number;
	peRatio?: number;
	profitMargin?: number;
	change?: number;
	ch1m?: number;
	ch1y?: number;
	grossMargin?: number;
};

function extractGroupsObject(html: string): Record<string, RawIndustryRow[]> {
	const literal =
		extractObjectLiteral(html, "industries") ??
		extractObjectLiteral(html, "groups");
	const value = evaluateObjectLiteral<Record<string, RawIndustryRow[]>>(literal);
	return typeof value === "object" && value !== null ? value : {};
}

function extractAllPageSlugOrder(html: string): string[] {
	const slugMatches = [...html.matchAll(/url:"([^"]+)"/g)];
	const slugs = slugMatches
		.map((match) => String(match[1] ?? "").trim())
		.filter(Boolean);
	return [...new Set(slugs)];
}

async function fetchAggregationRows(): Promise<
	Array<{ ch1m?: number; grossMargin?: number }>
> {
	const payload = await fetchJson<{
		data?: Array<{ ch1m?: number; grossMargin?: number }>;
	}>(STOCKANALYSIS_INDUSTRY_AGGREGATION_URL);
	return Array.isArray(payload?.data) ? payload.data : [];
}

function mergeAggregationBySlug(
	groupedRows: Record<string, RawIndustryRow[]>,
	allPageSlugOrder: string[],
	aggregationRows: Array<{ ch1m?: number; grossMargin?: number }>,
): Map<string, { ch1m?: number; grossMargin?: number }> {
	const bySlug = new Map<string, { ch1m?: number; grossMargin?: number }>();
	if (allPageSlugOrder.length !== aggregationRows.length) {
		return bySlug;
	}
	for (const [index, slug] of allPageSlugOrder.entries()) {
		bySlug.set(slug, aggregationRows[index] ?? {});
	}

	for (const rows of Object.values(groupedRows)) {
		for (const row of rows) {
			if (!row?.url || !bySlug.has(row.url)) {
				continue;
			}
			const merged = bySlug.get(row.url) ?? {};
			if (row.ch1m != null) {
				merged.ch1m = row.ch1m;
			}
			if (row.grossMargin != null) {
				merged.grossMargin = row.grossMargin;
			}
			bySlug.set(row.url, merged);
		}
	}

	return bySlug;
}

/** Scrape sector and industry summary rows from the StockAnalysis industries page. */
export async function scrapeIndustrySnapshot(): Promise<StockAnalysisIndustrySnapshot> {
	const [groupedHtml, allHtml, aggregationRows] = await Promise.all([
		fetchText(STOCKANALYSIS_INDUSTRY_URL),
		fetchText(STOCKANALYSIS_INDUSTRY_ALL_URL),
		fetchAggregationRows(),
	]);

	const groupedRows = groupedHtml ? extractGroupsObject(groupedHtml) : {};
	if (Object.keys(groupedRows).length === 0) {
		return {
			industries: [],
			meta: {
				source: "stockanalysis",
				fetched_at: null,
				sector_count: 0,
				industry_count: 0,
			},
		};
	}

	const slugOrder = allHtml ? extractAllPageSlugOrder(allHtml) : [];
	const aggregationBySlug = mergeAggregationBySlug(
		groupedRows,
		slugOrder,
		aggregationRows,
	);

	const industries = Object.entries(groupedRows).flatMap(([sector, rows]) =>
		(rows ?? [])
			.map((row) => {
				const industry = String(row.industry_name ?? "").trim();
				const slug = String(row.url ?? "").trim();
				const stockCount = Number(row.stocks);
				if (!industry || !slug || !Number.isFinite(stockCount)) {
					return null;
				}

				const aggregation = aggregationBySlug.get(slug);
				return {
					sector,
					industry,
					stock_count: stockCount,
					market_cap: toFiniteNumber(row.marketCap),
					pe: toFiniteNumber(row.peRatio),
					profit_margin: toFiniteNumber(row.profitMargin),
					gross_margin: toFiniteNumber(row.grossMargin ?? aggregation?.grossMargin),
					change_percent_1d: toFiniteNumber(row.change),
					change_percent_1m: toFiniteNumber(row.ch1m ?? aggregation?.ch1m),
					change_percent_1y: toFiniteNumber(row.ch1y),
				};
			})
			.filter((row): row is NonNullable<typeof row> => row !== null),
	);

	return {
		industries,
		meta: {
			source: "stockanalysis",
			fetched_at: industries.length > 0 ? new Date().toISOString() : null,
			sector_count: new Set(industries.map((row) => row.sector)).size,
			industry_count: industries.length,
		},
	};
}
