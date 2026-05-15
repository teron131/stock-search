/** Refresh stat families and resolve cache-vs-live decisions. */

import type { BackendStore, StockEntry } from "../api/data-store.js";
import {
	mergeAndNormalizeMonetaryFields,
	mergeStockAnalysisSnapshots,
	normalizeMonetaryFields,
} from "../monetary-fields.js";
import {
	BLOCKING_AUTO_FAMILIES,
	FAMILY_POLICIES,
	type StatsFamily,
} from "../stats-families.js";
import {
	chooseCachedSnapshot,
	completeKnownFamilyRow,
	familyCaches,
	familyRow,
	familyTimestamp,
	mergeFamilyRow,
} from "./family-cache.js";
import { ProviderBundle } from "./provider-bundle.js";
import type { FamilyResolution, StatsResolutionMode } from "./types.js";

const runningRefreshes = new Set<string>();

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
		const [statistics, yahoo] = await Promise.all([
			bundle.getStatistics(),
			bundle.getYahooIndicators(),
		]);
		return completeKnownFamilyRow(
			mergeAndNormalizeMonetaryFields(statistics, yahoo),
			family,
		);
	}
	if (family === "financials") {
		const [financials, statistics, yahoo] = await Promise.all([
			bundle.getFinancials(),
			bundle.getStatistics(),
			bundle.getYahooIndicators(),
		]);
		const merged = {
			...mergeStockAnalysisSnapshots(statistics, financials),
			revenue_growth: financials.revenue_growth ?? null,
			eps_growth: financials.eps_growth ?? null,
			gross_margin: financials.gross_margin ?? statistics.gross_margin ?? null,
			operating_margin:
				financials.operating_margin ?? statistics.operating_margin ?? null,
			fx: yahoo.fx,
		};
		normalizeMonetaryFields(merged);
		return completeKnownFamilyRow(merged, family);
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
	const refreshKey = `${ticker}:${family}`;
	if (runningRefreshes.has(refreshKey)) {
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

	runningRefreshes.add(refreshKey);
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
			runningRefreshes.delete(refreshKey);
		}
	})();
	return true;
}

export async function resolveFamily({
	bundle,
	store,
	ticker,
	family,
	mode,
	persistedRow,
	stockEntry,
}: {
	bundle: ProviderBundle;
	store: BackendStore;
	ticker: string;
	family: StatsFamily;
	mode: StatsResolutionMode;
	persistedRow: Record<string, unknown>;
	stockEntry: StockEntry | null;
}): Promise<FamilyResolution> {
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
