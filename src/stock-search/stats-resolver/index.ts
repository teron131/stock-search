/** Resolve ticker stats with family-level freshness and background refreshes. */

import type { BackendStore, StockEntry } from "../api/data-store.js";
import { PortfolioConfig } from "../config.js";
import { STAT_FAMILIES, type StatsFamily } from "../stats-families.js";
import { normalizeTicker } from "../utils.js";
import { mergeFamilyRow } from "./family-cache.js";
import { resolveFamily } from "./family-refresh.js";
import { ProviderBundle } from "./provider-bundle.js";
import type {
	FamilyResolution,
	StatsResolutionMode,
	StatsResolutionResult,
} from "./types.js";

export type { StatsResolutionMode, StatsResolutionResult } from "./types.js";

async function mapWithConcurrency<T, U>(
	items: T[],
	concurrency: number,
	mapper: (item: T) => Promise<U>,
): Promise<U[]> {
	const results = new Array<U>(items.length);
	let nextIndex = 0;
	const workerCount = Math.min(Math.max(1, concurrency), items.length);

	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (nextIndex < items.length) {
				const currentIndex = nextIndex;
				nextIndex += 1;
				results[currentIndex] = await mapper(items[currentIndex]);
			}
		}),
	);

	return results;
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
		families[family] = await resolveFamily({
			bundle,
			store,
			ticker,
			family,
			mode,
			persistedRow,
			stockEntry,
		});
		const resolvedFamily = families[family];
		const timestamp = resolvedFamily.timestamp;
		if (timestamp != null && Object.keys(resolvedFamily.row).length > 0) {
			Object.assign(
				persistedRow,
				mergeFamilyRow(persistedRow, family, resolvedFamily.row, timestamp),
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
	const unique = [
		...new Set(
			tickers.map((ticker) => normalizeTicker(ticker)).filter(Boolean),
		),
	];
	const prefetchedStocks =
		stockEntries ?? (await store.loadStocksByTickers(unique));
	const results = await mapWithConcurrency(
		unique,
		PortfolioConfig.MAX_WORKERS,
		async (ticker) =>
			[
				ticker,
				await resolveTickerStats(
					store,
					ticker,
					mode,
					prefetchedStocks[ticker] ?? null,
				),
			] as const,
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
