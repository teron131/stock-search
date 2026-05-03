/** Cache helpers for StockAnalysis sector snapshots. */

import { isCacheTimestampFresh } from "../../cache.js";
import type {
	StockAnalysisSectorSnapshot,
	StockAnalysisSectorSummary,
} from "./schemas.js";

const SECTOR_SNAPSHOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type SectorSnapshotCacheStore = {
	loadSectorSnapshot(key?: string): Promise<StockAnalysisSectorSnapshot | null>;
	saveSectorSnapshot(
		snapshot: StockAnalysisSectorSnapshot,
		key?: string,
	): Promise<void>;
};

function nullableNumber(value: unknown): number | null {
	if (value == null || (typeof value === "string" && !value.trim())) {
		return null;
	}
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

function normalizeTopTickers(value: unknown): string[] {
	return Array.isArray(value)
		? value.map((ticker) => String(ticker ?? "").trim()).filter(Boolean)
		: [];
}

function normalizeSectorRow(value: unknown): StockAnalysisSectorSummary | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const row = value as Record<string, unknown>;
	const sector = typeof row.sector === "string" ? row.sector.trim() : "";
	const stockCount = Number(row.stock_count);
	if (!sector || !Number.isFinite(stockCount)) {
		return null;
	}
	return {
		sector,
		top_tickers: normalizeTopTickers(row.top_tickers),
		stock_count: stockCount,
		market_cap: nullableNumber(row.market_cap),
		pe: nullableNumber(row.pe),
		profit_margin: nullableNumber(row.profit_margin),
		change_percent_1d: nullableNumber(row.change_percent_1d),
		change_percent_1y: nullableNumber(row.change_percent_1y),
	};
}

export function normalizeSectorSnapshot(
	value: unknown,
): StockAnalysisSectorSnapshot | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const snapshot = value as Record<string, unknown>;
	const meta =
		typeof snapshot.meta === "object" &&
		snapshot.meta !== null &&
		!Array.isArray(snapshot.meta)
			? (snapshot.meta as Record<string, unknown>)
			: null;
	if (!Array.isArray(snapshot.sectors) || !meta) {
		return null;
	}

	const sectors = snapshot.sectors
		.map(normalizeSectorRow)
		.filter((sector): sector is StockAnalysisSectorSummary => sector !== null);
	return {
		sectors,
		meta: {
			source:
				typeof meta.source === "string" ? meta.source : "stockanalysis-sectors",
			fetched_at: typeof meta.fetched_at === "string" ? meta.fetched_at : null,
			sector_count: Number(meta.sector_count) || sectors.length,
		},
	};
}

export function hasSectorRows(
	snapshot: StockAnalysisSectorSnapshot | null | undefined,
): snapshot is StockAnalysisSectorSnapshot {
	return Array.isArray(snapshot?.sectors) && snapshot.sectors.length > 0;
}

export function isFreshSectorSnapshot(
	snapshot: StockAnalysisSectorSnapshot | null | undefined,
): snapshot is StockAnalysisSectorSnapshot {
	return (
		hasSectorRows(snapshot) &&
		isCacheTimestampFresh(
			snapshot.meta.fetched_at,
			Date.now(),
			SECTOR_SNAPSHOT_CACHE_TTL_MS,
		)
	);
}

export async function loadCachedSectorSnapshot(
	store: SectorSnapshotCacheStore | undefined,
): Promise<StockAnalysisSectorSnapshot | null> {
	if (!store) {
		return null;
	}
	try {
		return await store.loadSectorSnapshot();
	} catch {
		return null;
	}
}

export async function saveCachedSectorSnapshot(
	store: SectorSnapshotCacheStore | undefined,
	snapshot: StockAnalysisSectorSnapshot,
): Promise<void> {
	if (!store || !hasSectorRows(snapshot)) {
		return;
	}
	try {
		await store.saveSectorSnapshot(snapshot);
	} catch {
		// Cache writes should not block serving a freshly fetched sector snapshot.
	}
}
