/** StockAnalysis-specific extraction into app snapshot shapes. */

import path from "node:path";

import { ExaAnswerAgent, ExaLoadAgent } from "llm-harness-js/agents";
import { z, type ZodType } from "zod";

import { appConfig } from "../../api/config.js";
import {
	isCacheTimestampFresh,
	loadJsonCache,
	writeJsonCache,
} from "../../cache.js";
import { SECTOR_LABELS, SECTOR_PATTERN_RULES } from "../../models/labels.js";
import { stockAnalysisStockPathForTicker } from "../provider-symbols.js";
import type {
	StockAnalysisEtfHolding,
	StockAnalysisEtfSector,
	StockAnalysisSectorSnapshot,
	StockAnalysisSectorSummary,
} from "./schemas.js";

const DEFAULT_CONTENT_OPTIONS = {
	maxCharacters: 20_000,
	maxAgeHours: 0,
	filterEmptyResults: false,
};

const STOCKANALYSIS_SYSTEM_PROMPT = [
	"You extract structured data only from the supplied StockAnalysis page contents fetched through Exa Contents.",
	"Do not search, use memory, infer updated facts, or merge in outside values.",
	"Return null for fields absent from the supplied contents.",
	"Preserve displayed table row order.",
	"Use percentage fields as displayed percentage-point numbers, not fractions.",
].join(" ");

const STOCKANALYSIS_STATISTICS_URL =
	"https://stockanalysis.com/stocks/{ticker}/statistics/";
const STOCKANALYSIS_FINANCIALS_URL =
	"https://stockanalysis.com/stocks/{ticker}/financials/";
const STOCKANALYSIS_ETF_HOLDINGS_URL =
	"https://stockanalysis.com/etf/{ticker}/holdings/";
const STOCKANALYSIS_SECTORS_URL =
	"https://stockanalysis.com/stocks/industry/sectors/";
const STOCKANALYSIS_SECTOR_URL =
	"https://stockanalysis.com/stocks/sector/{sector}/";
const SECTOR_SNAPSHOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SECTOR_TOP_TICKER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SECTOR_TOP_TICKER_COUNT = 5;
const SECTOR_TOP_TICKER_PAGE_MAX_CHARACTERS = 40_000;
const SECTOR_SNAPSHOT_CACHE_PATH = path.join(
	path.dirname(appConfig.dataSqlitePath),
	"stockanalysis-sectors.json",
);
const SECTOR_TOP_TICKER_CACHE_PATH = path.join(
	path.dirname(appConfig.dataSqlitePath),
	"stockanalysis-sector-top-tickers.json",
);

const NullableNumber = z.number().nullable();

const QuoteFieldsSchema = z.object({
	price: NullableNumber.optional(),
	change: NullableNumber.optional(),
	change_percent_1d: NullableNumber.optional(),
});

const RatingRowSchema = z.object({
	firm: z.string().nullable().optional(),
	to_grade: z.string().nullable().optional(),
	from_grade: z.string().nullable().optional(),
	action: z.string().nullable().optional(),
	date: z.string().nullable().optional(),
	analyst_count: NullableNumber.optional(),
	price_target: NullableNumber.optional(),
	upside_pct: NullableNumber.optional(),
});

const StatisticsSchema = z.object({
	market_cap: NullableNumber.optional(),
	beta: NullableNumber.optional(),
	fifty_two_week_price_change: NullableNumber.optional(),
	moving_average_50d: NullableNumber.optional(),
	moving_average_200d: NullableNumber.optional(),
	rsi: NullableNumber.optional(),
	average_volume_20d: NullableNumber.optional(),
	pe: NullableNumber.optional(),
	pe_forward: NullableNumber.optional(),
	peg: NullableNumber.optional(),
	roic: NullableNumber.optional(),
	gross_margin: NullableNumber.optional(),
	operating_margin: NullableNumber.optional(),
	debt_to_equity: NullableNumber.optional(),
	debt_to_ebitda: NullableNumber.optional(),
	free_cash_flow: NullableNumber.optional(),
	median_upside: NullableNumber.optional(),
	ratings: z.array(RatingRowSchema).nullable().optional(),
});

const FinancialsSchema = z.object({
	revenue_growth: NullableNumber.optional(),
	eps_diluted: NullableNumber.optional(),
	eps_growth: NullableNumber.optional(),
	gross_margin: NullableNumber.optional(),
	operating_margin: NullableNumber.optional(),
});

const EtfHoldingSchema = z.object({
	ticker: z.string(),
	name: z.string().nullable().optional(),
	weight: z.number(),
});

const EtfHoldingsSchema = z.object({
	holdings: z.array(EtfHoldingSchema).default([]),
});

const EtfSectorSchema = z.object({
	name: z.string(),
	weight: z.number(),
});

const EtfSectorsSchema = z.object({
	sectors: z.array(EtfSectorSchema).default([]),
});

const SectorRowSchema = z.object({
	sector: z.string(),
	stock_count: z.number(),
	market_cap: NullableNumber,
	pe: NullableNumber,
	profit_margin: NullableNumber,
	change_percent_1d: NullableNumber,
	change_percent_1y: NullableNumber,
});

const SectorSnapshotSchema = z.object({
	sectors: z.array(SectorRowSchema).default([]),
});

const SectorSnapshotCacheSchema = z.object({
	fetched_at: z.string().nullable().default(null),
	sectors: z.array(SectorRowSchema).default([]),
});

const SectorTopTickerCacheEntrySchema = z.object({
	fetched_at: z.string(),
	tickers: z.array(z.string()).default([]),
});

const SectorTopTickerCacheSchema = z.object({
	entries: z.record(z.string(), SectorTopTickerCacheEntrySchema).default({}),
});

type SectorRow = z.output<typeof SectorRowSchema>;

type SectorSnapshotCache = z.output<typeof SectorSnapshotCacheSchema>;

type SectorTopTickerCache = z.output<typeof SectorTopTickerCacheSchema>;

type SectorTopTickerCacheMatch = {
	freshTickers: string[] | null;
	fallbackTickers: string[] | null;
};

type QuoteFields = z.output<typeof QuoteFieldsSchema>;

function stockUrl(template: string, tickerLower: string): string {
	return template.replace("{ticker}", tickerLower);
}

function stockDataUrl(template: string, ticker: string): string {
	const path = stockAnalysisStockPathForTicker(ticker);
	return template.replace("stocks/{ticker}", path).replace("{ticker}", ticker);
}

function sectorSlug(sectorName: string): string {
	return sectorName
		.trim()
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function sectorUrl(sectorName: string): string {
	return STOCKANALYSIS_SECTOR_URL.replace("{sector}", sectorSlug(sectorName));
}

function normalizeTickerSymbol(value: string): string {
	return value
		.trim()
		.toUpperCase()
		.replace(/^NYSE:/, "")
		.replace(/^NASDAQ:/, "")
		.replace(/^AMEX:/, "");
}

function normalizeTopTickers(values: string[]): string[] {
	const tickers: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const ticker = normalizeTickerSymbol(String(value || ""));
		if (!ticker || seen.has(ticker)) {
			continue;
		}
		seen.add(ticker);
		tickers.push(ticker);
		if (tickers.length >= SECTOR_TOP_TICKER_COUNT) {
			break;
		}
	}
	return tickers;
}

function parseSectorTopTickers(text: string): string[] {
	const topTickers: string[] = [];
	for (const line of text.split("\n")) {
		const rowMatch = line
			.trim()
			.match(/^\|\s*\d+\s*\|\s*([A-Za-z][A-Za-z0-9.-]*)\s*\|/);
		if (!rowMatch?.[1]) {
			continue;
		}
		topTickers.push(rowMatch[1]);
		if (topTickers.length >= SECTOR_TOP_TICKER_COUNT) {
			break;
		}
	}
	return normalizeTopTickers(topTickers);
}

function normalizeSectorRows(rows: SectorRow[]): StockAnalysisSectorSummary[] {
	return rows
		.map((sector) => ({
			...sector,
			top_tickers: [] as string[],
		}))
		.filter(
			(row): row is StockAnalysisSectorSummary =>
				!!row.sector && Number.isFinite(row.stock_count),
		);
}

function toSectorCacheRows(rows: StockAnalysisSectorSummary[]): SectorRow[] {
	return rows.map(
		({
			sector,
			stock_count,
			market_cap,
			pe,
			profit_margin,
			change_percent_1d,
			change_percent_1y,
		}) => ({
			sector,
			stock_count,
			market_cap,
			pe,
			profit_margin,
			change_percent_1d,
			change_percent_1y,
		}),
	);
}

async function loadSectorSnapshotCache(): Promise<SectorSnapshotCache> {
	return loadJsonCache(
		SECTOR_SNAPSHOT_CACHE_PATH,
		SectorSnapshotCacheSchema,
		() => ({ fetched_at: null, sectors: [] }),
	);
}

async function writeSectorSnapshotCache(
	cache: SectorSnapshotCache,
): Promise<void> {
	await writeJsonCache(SECTOR_SNAPSHOT_CACHE_PATH, cache);
}

async function loadSectorTopTickerCache(): Promise<SectorTopTickerCache> {
	return loadJsonCache(
		SECTOR_TOP_TICKER_CACHE_PATH,
		SectorTopTickerCacheSchema,
		() => ({ entries: {} }),
	);
}

async function writeSectorTopTickerCache(
	cache: SectorTopTickerCache,
): Promise<void> {
	await writeJsonCache(SECTOR_TOP_TICKER_CACHE_PATH, cache);
}

function readCachedSectorTopTickers(
	cache: SectorTopTickerCache,
	slug: string,
	now: Date,
): SectorTopTickerCacheMatch {
	const entry = cache.entries[slug];
	if (!entry?.tickers.length) {
		return { freshTickers: null, fallbackTickers: null };
	}

	const tickers = normalizeTopTickers(entry.tickers);
	if (tickers.length === 0) {
		return { freshTickers: null, fallbackTickers: null };
	}

	const isFresh = isCacheTimestampFresh(
		entry.fetched_at,
		now,
		SECTOR_TOP_TICKER_CACHE_TTL_MS,
	);
	return {
		freshTickers: isFresh ? tickers : null,
		fallbackTickers: tickers,
	};
}

function normalizeSectorName(value: string): string {
	const sectorText = value.trim();
	for (const label of Object.values(SECTOR_LABELS)) {
		if (sectorText.toLowerCase() === label.toLowerCase()) {
			return label;
		}
	}
	for (const [pattern, label] of SECTOR_PATTERN_RULES) {
		if (new RegExp(pattern, "i").test(sectorText)) {
			return label;
		}
	}
	return SECTOR_LABELS.other;
}

async function loadStockAnalysisPage<T extends ZodType>({
	urls,
	outputSchema,
	instruction,
	maxCharacters = DEFAULT_CONTENT_OPTIONS.maxCharacters,
}: {
	urls: string | string[];
	outputSchema: T;
	instruction: string;
	maxCharacters?: number;
}): Promise<z.output<T>> {
	const agent = new ExaLoadAgent<T>({
		outputSchema,
		contentOptions: {
			...DEFAULT_CONTENT_OPTIONS,
			maxCharacters,
		},
		systemPrompt: STOCKANALYSIS_SYSTEM_PROMPT,
	});
	return (await agent.invoke(urls, instruction)) as z.output<T>;
}

async function loadStockAnalysisPageOrDefault<T extends ZodType>({
	urls,
	outputSchema,
	instruction,
	defaultValue,
	maxCharacters,
}: {
	urls: string | string[];
	outputSchema: T;
	instruction: string;
	defaultValue: z.output<T>;
	maxCharacters?: number;
}): Promise<z.output<T>> {
	try {
		return await loadStockAnalysisPage({
			urls,
			outputSchema,
			instruction,
			maxCharacters,
		});
	} catch {
		return defaultValue;
	}
}

async function answerWithExaOrDefault<T extends ZodType>({
	query,
	outputSchema,
	systemPrompt,
	defaultValue,
}: {
	query: string;
	outputSchema: T;
	systemPrompt: string;
	defaultValue: z.output<T>;
}): Promise<z.output<T>> {
	try {
		return await new ExaAnswerAgent(systemPrompt, outputSchema).invoke(query);
	} catch {
		return defaultValue;
	}
}

async function fetchSectorTopTickers(
	sectorNames: string[],
): Promise<Map<string, string[]>> {
	if (sectorNames.length === 0) {
		return new Map();
	}

	const agent = new ExaLoadAgent({
		contentOptions: {
			...DEFAULT_CONTENT_OPTIONS,
			maxCharacters: SECTOR_TOP_TICKER_PAGE_MAX_CHARACTERS,
		},
	});
	const { pages } = await agent.load(sectorNames.map(sectorUrl));
	const tickersBySlug = new Map<string, string[]>();
	for (const [index, sectorName] of sectorNames.entries()) {
		const page = pages[index];
		const slug = sectorSlug(sectorName);
		const tickers = parseSectorTopTickers(page?.text ?? "");
		if (slug && tickers.length > 0) {
			tickersBySlug.set(slug, tickers);
		}
	}
	return tickersBySlug;
}

async function fetchSectorRows(): Promise<StockAnalysisSectorSummary[]> {
	const output = await loadStockAnalysisPage({
		urls: STOCKANALYSIS_SECTORS_URL,
		outputSchema: SectorSnapshotSchema,
		instruction: [
			"Extract StockAnalysis sector summary rows from the supplied sectors page.",
			"Return every sector row visible in the supplied contents.",
			"Use stock_count as an integer count.",
			"Use market_cap as absolute dollars when displayed; otherwise null.",
			"Use profit_margin and displayed change_percent fields as 0-100 numeric values.",
		].join("\n"),
	});
	return normalizeSectorRows(output.sectors);
}

async function loadSectorRowsWithCache(): Promise<StockAnalysisSectorSummary[]> {
	const now = new Date();
	const cache = await loadSectorSnapshotCache();
	const cachedRows = normalizeSectorRows(cache.sectors);
	if (
		cachedRows.length > 0 &&
		isCacheTimestampFresh(cache.fetched_at, now, SECTOR_SNAPSHOT_CACHE_TTL_MS)
	) {
		return cachedRows;
	}

	try {
		const fetchedRows = await fetchSectorRows();
		if (fetchedRows.length > 0) {
			await writeSectorSnapshotCache({
				fetched_at: now.toISOString(),
				sectors: toSectorCacheRows(fetchedRows),
			});
			return fetchedRows;
		}
	} catch {
		// Fall through to stale cache rows when live refresh is unavailable.
	}

	return cachedRows;
}

async function enrichSectorsWithTopTickers(
	sectors: StockAnalysisSectorSummary[],
): Promise<StockAnalysisSectorSummary[]> {
	const now = new Date();
	const cache = await loadSectorTopTickerCache();
	const tickersBySlug = new Map<string, string[]>();
	const staleTickersBySlug = new Map<string, string[]>();
	const missingSectorNames: string[] = [];

	for (const sector of sectors) {
		const slug = sectorSlug(sector.sector);
		const cachedTickers = readCachedSectorTopTickers(cache, slug, now);
		if (cachedTickers.freshTickers) {
			tickersBySlug.set(slug, cachedTickers.freshTickers);
			continue;
		}
		if (cachedTickers.fallbackTickers) {
			staleTickersBySlug.set(slug, cachedTickers.fallbackTickers);
		}
		missingSectorNames.push(sector.sector);
	}

	const fetchedTickersBySlug = await fetchSectorTopTickers(missingSectorNames);
	const fetchedAt = now.toISOString();
	let cacheChanged = false;
	for (const [slug, tickers] of fetchedTickersBySlug) {
		cache.entries[slug] = { fetched_at: fetchedAt, tickers };
		tickersBySlug.set(slug, tickers);
		cacheChanged = true;
	}

	if (cacheChanged) {
		await writeSectorTopTickerCache(cache);
	}

	return sectors.map((sector) => ({
		...sector,
		top_tickers:
			tickersBySlug.get(sectorSlug(sector.sector)) ??
			staleTickersBySlug.get(sectorSlug(sector.sector)) ??
			[],
	}));
}

/** Load quote fields from a StockAnalysis statistics page. */
export async function loadQuoteFields(
	tickerLower: string,
): Promise<Required<QuoteFields>> {
	const url = stockDataUrl(STOCKANALYSIS_STATISTICS_URL, tickerLower);
	const output = await loadStockAnalysisPageOrDefault({
		urls: url,
		outputSchema: QuoteFieldsSchema,
		defaultValue: {
			price: null,
			change: null,
			change_percent_1d: null,
		},
		instruction: [
			`Extract current quote fields for ${tickerLower.toUpperCase()} from the supplied StockAnalysis statistics page.`,
			"Return price, absolute change, and one-day change percentage if explicitly displayed.",
		].join("\n"),
	});
	return {
		price: output.price ?? null,
		change: output.change ?? null,
		change_percent_1d: output.change_percent_1d ?? null,
	};
}

/** Load the StockAnalysis statistics page into the app statistics shape. */
export async function loadStatisticsSnapshot(
	tickerLower: string,
): Promise<Record<string, unknown>> {
	const url = stockDataUrl(STOCKANALYSIS_STATISTICS_URL, tickerLower);
	return loadStockAnalysisPageOrDefault({
		urls: url,
		outputSchema: StatisticsSchema,
		defaultValue: {},
		instruction: [
			`Extract the StockAnalysis statistics schema for ${tickerLower.toUpperCase()}.`,
			`Source URL: ${url}`,
			"Use market_cap and free_cash_flow as absolute dollar values.",
			"Use pe, pe_forward, peg, beta, roic, debt_to_equity, and debt_to_ebitda as displayed numeric ratios.",
			"Use gross_margin, operating_margin, rsi, median_upside, and price-change fields as 0-100 numeric values.",
			"If analyst consensus and price-target fields are visible, return one ratings row with firm 'Consensus'.",
		].join("\n"),
	});
}

/** Load the StockAnalysis financials page into the app financials shape. */
export async function loadFinancialsSnapshot(
	tickerLower: string,
): Promise<Record<string, unknown>> {
	const url = stockDataUrl(STOCKANALYSIS_FINANCIALS_URL, tickerLower);
	return loadStockAnalysisPageOrDefault({
		urls: url,
		outputSchema: FinancialsSchema,
		defaultValue: {},
		instruction: [
			`Extract the StockAnalysis financials schema for ${tickerLower.toUpperCase()}.`,
			`Source URL: ${url}`,
			"Use only the first/current data column in the table.",
			"Ignore older columns to the right.",
			"Use revenue_growth, eps_growth, gross_margin, and operating_margin as 0-100 numeric values.",
		].join("\n"),
	});
}

/** Load ETF holdings from the StockAnalysis holdings page. */
export async function loadEtfHoldingsSnapshot(
	tickerLower: string,
): Promise<StockAnalysisEtfHolding[]> {
	const url = stockUrl(STOCKANALYSIS_ETF_HOLDINGS_URL, tickerLower);
	const output = await loadStockAnalysisPageOrDefault({
		urls: url,
		outputSchema: EtfHoldingsSchema,
		defaultValue: { holdings: [] },
		instruction: [
			`Extract ETF holdings for ${tickerLower.toUpperCase()} from the supplied StockAnalysis holdings table.`,
			`Source URL: ${url}`,
			"Return holdings in displayed table order.",
			"Use weight as a 0-100 numeric percentage.",
			"Preserve non-US exchange prefixes or suffixes when StockAnalysis displays them.",
			"Exclude US exchange prefixes.",
		].join("\n"),
	});
	return output.holdings.map((holding) => ({
		ticker: holding.ticker,
		name: holding.name ?? null,
		weight: holding.weight,
	}));
}

/** Load ETF sector allocation from web search when page contents omit it. */
export async function loadEtfSectorsSnapshot(
	tickerLower: string,
): Promise<StockAnalysisEtfSector[]> {
	const ticker = tickerLower.toUpperCase();
	const today = new Date().toISOString().slice(0, 10);
	const output = await answerWithExaOrDefault({
		outputSchema: EtfSectorsSchema,
		defaultValue: { sectors: [] },
		query: [
			`As of ${today}, find the latest sector allocation or sector exposure breakdown for ETF ${ticker}.`,
			"Prefer the ETF issuer's official website, factsheet, holdings CSV, or fund page.",
			"Use StockAnalysis or Schwab only if an issuer source is not available.",
			"Do not use Yahoo.",
		].join(" "),
		systemPrompt: [
			"You extract ETF sector allocation data for a portfolio cache.",
			"Freshness and source quality matter: prefer official issuer sources first, then StockAnalysis, then Schwab.",
			"Return sectors only when a source explicitly shows sector allocation, sector exposure, or sector breakdown for the ETF.",
			"Do not infer sectors from holdings, company names, labels, or memory.",
			"Use numeric weights in 0-100 percentage format.",
			"Normalize sector names to concise display labels such as Technology, Healthcare, Financials, Consumer Cyclical, Consumer Defensive, Industrials, Energy, Utilities, Real Estate, Communication Services, Materials, or Other.",
			"Prefer a complete sector breakdown whose weights sum approximately to 100.",
			"If unavailable or ambiguous, return an empty sectors array.",
		].join("\n"),
	});
	return output.sectors.map((sector) => ({
		name: normalizeSectorName(sector.name),
		weight: sector.weight,
	}));
}

/** Load sector summary rows from StockAnalysis. */
export async function loadSectorSnapshot(): Promise<StockAnalysisSectorSnapshot> {
	const sectors = await loadSectorRowsWithCache();
	const enrichedSectors = await enrichSectorsWithTopTickers(sectors);
	return {
		sectors: enrichedSectors,
		meta: {
			source: "stockanalysis-sectors",
			fetched_at: enrichedSectors.length > 0 ? new Date().toISOString() : null,
			sector_count: new Set(enrichedSectors.map((row) => row.sector)).size,
		},
	};
}
