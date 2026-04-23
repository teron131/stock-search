/** Resolve ticker stats with family-level freshness and background refreshes. */

import type { BackendStore, StockEntry } from "./api/data-store.js";
import { nowIso, normalizeTicker } from "./utils.js";
import {
	fetchStockAnalysisFinancials,
	fetchStockAnalysisStatistics,
	fetchYahooIndicators,
	fetchYahooSymbolMetadata,
} from "./indicators.js";
import {
	BLOCKING_AUTO_FAMILIES,
	FAMILY_FIELDS,
	FAMILY_POLICIES,
	FAMILY_TIMESTAMP_FIELD,
	STAT_FAMILIES,
	type StatsFamily,
} from "./stats-families.js";

export type StatsResolutionMode = "auto" | "live" | "cache";

type FamilyDecision = "fresh" | "stale_served" | "inline_refresh" | "missing";
type SourceTier = "l1" | "l2" | "live" | "missing";

type FamilyResolution = {
	family: StatsFamily;
	row: Record<string, unknown>;
	decision: FamilyDecision;
	sourceTier: SourceTier;
	timestamp: number | null;
	queuedRefresh: boolean;
};

export type StatsResolutionResult = {
	row: Record<string, unknown>;
	dataSource: "cache" | "live" | "live_with_cache_fallback";
	families: Record<StatsFamily, FamilyResolution>;
};

type FamilyCacheEntry = {
	value: Record<string, unknown>;
	updatedAt: number;
	lastFailureAt: number | null;
};

class ProviderBundle {
	private yahooPromise: Promise<Record<string, unknown>> | null = null;
	private yahooMetaPromise: Promise<Record<string, unknown>> | null = null;
	private statisticsPromise: Promise<Record<string, unknown>> | null = null;
	private financialsPromise: Promise<Record<string, unknown>> | null = null;

	constructor(private readonly ticker: string) {}

	/** Return the cached Yahoo price and momentum payload. */
	getYahooIndicators(): Promise<Record<string, unknown>> {
		this.yahooPromise ??= fetchYahooIndicators(this.ticker);
		return this.yahooPromise;
	}

	/** Return the cached Yahoo symbol metadata payload. */
	getYahooMetadata(): Promise<Record<string, unknown>> {
		this.yahooMetaPromise ??= fetchYahooSymbolMetadata(this.ticker);
		return this.yahooMetaPromise;
	}

	/** Return the cached StockAnalysis statistics payload. */
	getStatistics(): Promise<Record<string, unknown>> {
		this.statisticsPromise ??= fetchStockAnalysisStatistics(this.ticker);
		return this.statisticsPromise;
	}

	/** Return the cached StockAnalysis financials payload. */
	getFinancials(): Promise<Record<string, unknown>> {
		this.financialsPromise ??= fetchStockAnalysisFinancials(this.ticker);
		return this.financialsPromise;
	}
}

const familyCaches: Record<StatsFamily, Map<string, FamilyCacheEntry>> = {
	market_data: new Map(),
	market_snapshot: new Map(),
	statistics: new Map(),
	financials: new Map(),
	ratings: new Map(),
};
const runningRefreshes = new Set<string>();

function resolutionKey(ticker: string, family: StatsFamily): string {
	return `${ticker}:${family}`;
}

function parseTimestamp(value: unknown): number | null {
	if (typeof value !== "string" || !value.trim()) {
		return null;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function familyTimestamp(
	row: Record<string, unknown>,
	family: StatsFamily,
): number | null {
	return parseTimestamp(row[FAMILY_TIMESTAMP_FIELD[family]]);
}

function familyRow(
	row: Record<string, unknown>,
	family: StatsFamily,
): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	for (const field of FAMILY_FIELDS[family]) {
		if (field in row) {
			output[field] = row[field];
		}
	}
	return output;
}

function hasMeaningfulPayload(value: unknown): boolean {
	if (value == null) {
		return false;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toUpperCase();
		return normalized !== "" && normalized !== "NONE";
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	if (typeof value === "object") {
		return Object.keys(value as Record<string, unknown>).length > 0;
	}
	return true;
}

function hasFamilyPayload(
	row: Record<string, unknown>,
	family: StatsFamily,
): boolean {
	return FAMILY_FIELDS[family].some((field) => hasMeaningfulPayload(row[field]));
}

function chooseCachedSnapshot(
	ticker: string,
	family: StatsFamily,
	persistedRow: Record<string, unknown>,
	now: number,
): {
	sourceTier: SourceTier;
	row: Record<string, unknown>;
	timestamp: number | null;
	isFresh: boolean;
	isStale: boolean;
	present: boolean;
} {
	const persistedFamilyRow = familyRow(persistedRow, family);
	let sourceTier: SourceTier = "missing";
	let chosenRow: Record<string, unknown> = {};
	let chosenTimestamp = familyTimestamp(persistedRow, family);

	if (hasFamilyPayload(persistedFamilyRow, family)) {
		sourceTier = "l2";
		chosenRow = persistedFamilyRow;
	}

	const l1Entry = familyCaches[family].get(ticker);
	if (
		l1Entry &&
		hasFamilyPayload(l1Entry.value, family) &&
		(chosenTimestamp == null || l1Entry.updatedAt >= chosenTimestamp)
	) {
		sourceTier = "l1";
		chosenRow = { ...l1Entry.value };
		chosenTimestamp = l1Entry.updatedAt;
	}

	if (chosenTimestamp == null) {
		return {
			sourceTier,
			row: chosenRow,
			timestamp: null,
			isFresh: false,
			isStale: false,
			present: Object.keys(chosenRow).length > 0,
		};
	}

	const policy = FAMILY_POLICIES[family];
	return {
		sourceTier,
		row: chosenRow,
		timestamp: chosenTimestamp,
		isFresh: chosenTimestamp >= now - policy.freshWindowMs,
		isStale: chosenTimestamp >= now - policy.staleWindowMs,
		present: Object.keys(chosenRow).length > 0,
	};
}

function mergeFamilyRow(
	baseRow: Record<string, unknown>,
	family: StatsFamily,
	nextRow: Record<string, unknown>,
	timestamp: number,
): Record<string, unknown> {
	const merged = { ...baseRow };
	for (const field of FAMILY_FIELDS[family]) {
		if (field in nextRow) {
			merged[field] = nextRow[field];
		}
	}
	merged[FAMILY_TIMESTAMP_FIELD[family]] = new Date(timestamp).toISOString();
	return merged;
}

async function refreshFamilyRow(
	bundle: ProviderBundle,
	family: StatsFamily,
): Promise<Record<string, unknown>> {
	if (family === "market_data") {
		const yahoo = await bundle.getYahooIndicators();
		return familyRow(yahoo, family);
	}
	if (family === "market_snapshot") {
		const [yahoo, metadata] = await Promise.all([
			bundle.getYahooIndicators(),
			bundle.getYahooMetadata(),
		]);
		return familyRow({ ...yahoo, ...metadata }, family);
	}
	if (family === "statistics") {
		return familyRow(await bundle.getStatistics(), family);
	}
	if (family === "financials") {
		const [financials, statistics] = await Promise.all([
			bundle.getFinancials(),
			bundle.getStatistics(),
		]);
		return familyRow(
			{
				...statistics,
				...financials,
				gross_margin:
					financials.gross_margin ?? statistics.gross_margin ?? null,
				debt_to_equity: statistics.debt_to_equity ?? null,
			},
			family,
		);
	}
	return familyRow(await bundle.getYahooIndicators(), family);
}

async function persistIndicators(
	store: BackendStore,
	ticker: string,
	indicators: Record<string, unknown>,
	stockEntry: StockEntry | null,
): Promise<void> {
	await store.upsertStocks([
		{
			ticker,
			indicators,
			evaluation: stockEntry?.evaluation ?? {},
			labels: stockEntry?.labels ?? [],
		},
	]);
}

async function queueRefresh(
	store: BackendStore,
	ticker: string,
	family: StatsFamily,
	persistedRow: Record<string, unknown>,
	stockEntry: StockEntry | null,
): Promise<boolean> {
	const key = resolutionKey(ticker, family);
	if (runningRefreshes.has(key)) {
		return false;
	}
	const entry = familyCaches[family].get(ticker);
	const cooldownMs = FAMILY_POLICIES[family].failureCooldownMs;
	if (
		entry?.lastFailureAt != null &&
		entry.lastFailureAt > Date.now() - cooldownMs
	) {
		return false;
	}

	runningRefreshes.add(key);
	void (async () => {
		const bundle = new ProviderBundle(ticker);
		const refreshedAt = Date.now();
		try {
			const refreshedRow = await refreshFamilyRow(bundle, family);
			familyCaches[family].set(ticker, {
				value: refreshedRow,
				updatedAt: refreshedAt,
				lastFailureAt: null,
			});
			const mergedIndicators = mergeFamilyRow(
				persistedRow,
				family,
				refreshedRow,
				refreshedAt,
			);
			await persistIndicators(store, ticker, mergedIndicators, stockEntry);
		} catch {
			familyCaches[family].set(ticker, {
				value: entry?.value ?? {},
				updatedAt: entry?.updatedAt ?? refreshedAt,
				lastFailureAt: refreshedAt,
			});
		} finally {
			runningRefreshes.delete(key);
		}
	})();
	return true;
}

function classifyDataSource(
	mode: StatsResolutionMode,
	families: Record<StatsFamily, FamilyResolution>,
): "cache" | "live" | "live_with_cache_fallback" {
	if (mode === "cache") {
		return "cache";
	}
	const isLive = Object.values(families).every(
		(resolution) =>
			(resolution.sourceTier === "live" || resolution.sourceTier === "l1") &&
			!resolution.queuedRefresh,
	);
	return isLive ? "live" : "live_with_cache_fallback";
}

async function resolveFamily(
	bundle: ProviderBundle,
	store: BackendStore,
	ticker: string,
	family: StatsFamily,
	mode: StatsResolutionMode,
	persistedRow: Record<string, unknown>,
	stockEntry: StockEntry | null,
): Promise<FamilyResolution> {
	if (mode === "cache") {
		const row = familyRow(persistedRow, family);
		return {
			family,
			row,
			decision: Object.keys(row).length > 0 ? "fresh" : "missing",
			sourceTier: Object.keys(row).length > 0 ? "l2" : "missing",
			timestamp: familyTimestamp(persistedRow, family),
			queuedRefresh: false,
		};
	}

	const now = Date.now();
	const cached = chooseCachedSnapshot(ticker, family, persistedRow, now);
	if (mode === "auto" && cached.isFresh) {
		return {
			family,
			row: cached.row,
			decision: "fresh",
			sourceTier: cached.sourceTier,
			timestamp: cached.timestamp,
			queuedRefresh: false,
		};
	}

	if (
		mode === "auto" &&
		cached.isStale &&
		!BLOCKING_AUTO_FAMILIES.has(family)
	) {
		return {
			family,
			row: cached.row,
			decision: "stale_served",
			sourceTier: cached.sourceTier,
			timestamp: cached.timestamp,
			queuedRefresh: await queueRefresh(
				store,
				ticker,
				family,
				persistedRow,
				stockEntry,
			),
		};
	}

	const refreshedAt = Date.now();
	try {
		const refreshedRow = await refreshFamilyRow(bundle, family);
		familyCaches[family].set(ticker, {
			value: refreshedRow,
			updatedAt: refreshedAt,
			lastFailureAt: null,
		});
		const mergedIndicators = mergeFamilyRow(
			persistedRow,
			family,
			refreshedRow,
			refreshedAt,
		);
		await persistIndicators(store, ticker, mergedIndicators, stockEntry);
		Object.assign(persistedRow, mergedIndicators);
		return {
			family,
			row: refreshedRow,
			decision: "inline_refresh",
			sourceTier: "live",
			timestamp: refreshedAt,
			queuedRefresh: false,
		};
	} catch {
		const previous = familyCaches[family].get(ticker);
		familyCaches[family].set(ticker, {
			value: previous?.value ?? {},
			updatedAt: previous?.updatedAt ?? refreshedAt,
			lastFailureAt: refreshedAt,
		});
		if (mode === "live") {
			throw new Error(`Live stats unavailable for ticker: ${ticker}`);
		}
		if (cached.isStale && cached.present) {
			return {
				family,
				row: cached.row,
				decision: "stale_served",
				sourceTier: cached.sourceTier,
				timestamp: cached.timestamp,
				queuedRefresh: false,
			};
		}
		return {
			family,
			row: {},
			decision: "missing",
			sourceTier: "missing",
			timestamp: null,
			queuedRefresh: false,
		};
	}
}

/** Resolve one ticker row using the family-based cache and refresh policy. */
export async function resolveTickerStats(
	store: BackendStore,
	tickerInput: string,
	mode: StatsResolutionMode,
	stockEntryOverride?: StockEntry | null,
): Promise<StatsResolutionResult> {
	const ticker = normalizeTicker(tickerInput);
	if (!ticker) {
		throw new Error("Invalid ticker");
	}

	const stockEntry = stockEntryOverride ?? (await store.loadStock(ticker));
	const persistedRow = { ...(stockEntry?.indicators ?? {}) };
	const families = {} as Record<StatsFamily, FamilyResolution>;
	const bundle = new ProviderBundle(ticker);

	for (const family of STAT_FAMILIES) {
		families[family] = await resolveFamily(
			bundle,
			store,
			ticker,
			family,
			mode,
			persistedRow,
			stockEntry,
		);
		if (families[family].timestamp != null && Object.keys(families[family].row).length > 0) {
			Object.assign(
				persistedRow,
				mergeFamilyRow(
					persistedRow,
					family,
					families[family].row,
					families[family].timestamp!,
				),
			);
		}
	}

	return {
		row: persistedRow,
		dataSource: classifyDataSource(mode, families),
		families,
	};
}

/** Resolve several ticker rows in parallel using the shared family resolver. */
export async function resolveTickerStatsMap(
	store: BackendStore,
	tickers: string[],
	mode: StatsResolutionMode,
	stockEntries?: Record<string, StockEntry>,
): Promise<Record<string, StatsResolutionResult>> {
	const unique = [...new Set(tickers.map((ticker) => normalizeTicker(ticker)).filter(Boolean))];
	const prefetchedStocks =
		stockEntries ?? (await store.loadStocksByTickers(unique));
	const results = await Promise.all(
		unique.map(
			async (ticker) =>
				[
					ticker,
					await resolveTickerStats(store, ticker, mode, prefetchedStocks[ticker] ?? null),
				] as const,
		),
	);
	return Object.fromEntries(results);
}

/** Aggregate per-ticker data-source labels into one public portfolio label. */
export function aggregateTickerDataSource(
	results: Record<string, StatsResolutionResult>,
	mode: StatsResolutionMode,
): "cache" | "live" | "live_with_cache_fallback" {
	if (mode === "cache" || Object.keys(results).length === 0) {
		return "cache";
	}
	return Object.values(results).every((result) => result.dataSource === "live")
		? "live"
		: "live_with_cache_fallback";
}

/** Return the generated timestamp for the current resolver response. */
export function generatedAtIso(): string {
	return nowIso();
}
