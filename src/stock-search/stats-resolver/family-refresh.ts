/** Refresh stat families and resolve cache-vs-live decisions. */

import { policy } from "../policy.js";
import type { BackendStore, StockEntry } from "../storage/index.js";
import {
	applySourcePegFallback,
	PEG_SOURCE_FINVIZ,
	PEG_SOURCE_STOCKANALYSIS,
} from "./derived-stats.js";
import { FAMILY_POLICIES, type StatsFamily } from "./families.js";
import {
	chooseCachedSnapshot,
	completeKnownFamilyRow,
	familyCaches,
	familyRow,
	familyTimestamp,
	mergeFamilyRow,
} from "./family-cache.js";
import {
	mergeAndNormalizeMonetaryFields,
	mergeStockAnalysisSnapshots,
	normalizeMonetaryFields,
} from "./monetary-fields.js";
import { ProviderBundle } from "./provider-bundle.js";
import {
	mergeSourceFields,
	SAME_DEFINITION_BLEND_FIELDS,
	SOURCE_FINVIZ,
	SOURCE_STOCKANALYSIS,
	type SourceFieldPolicy,
	sourceFieldPolicies,
} from "./source-merge.js";
import type {
	FamilyCacheEntry,
	FamilyResolution,
	StatsResolutionMode,
} from "./types.js";

const runningRefreshes = new Set<string>();
const STATISTICS_PROVIDER_POLICIES = sourceFieldPolicies(
	{
		fields: ["revenue"],
		mode: "mean",
		sources: [SOURCE_STOCKANALYSIS, SOURCE_FINVIZ],
	},
	{
		fields: SAME_DEFINITION_BLEND_FIELDS,
		mode: "mean",
		sources: [SOURCE_STOCKANALYSIS, SOURCE_FINVIZ],
	},
);
const FINANCIALS_PROVIDER_POLICIES = sourceFieldPolicies({
	fields: ["revenue", "revenue_growth", "eps_growth"],
	mode: "mean",
	sources: [SOURCE_STOCKANALYSIS, SOURCE_FINVIZ],
});

type PersistedFamilyRefresh = {
	mergedFamilyRow: Record<string, unknown>;
	mergedIndicators: Record<string, unknown>;
};

function mergeStockAnalysisFinvizFields(
	stockAnalysis: Record<string, unknown>,
	finviz: Record<string, unknown>,
	policies: SourceFieldPolicy[],
): Record<string, unknown> {
	return mergeSourceFields({
		fields: new Set([...Object.keys(stockAnalysis), ...Object.keys(finviz)]),
		sources: [
			{ source: SOURCE_STOCKANALYSIS, fields: stockAnalysis },
			{ source: SOURCE_FINVIZ, fields: finviz },
		],
		policies,
	});
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
		const [yahoo, stockAnalysisStatistics, finvizStatistics] =
			await Promise.all([
				bundle.getYahooIndicators(),
				bundle.getStockAnalysisStatistics(),
				bundle.getFinvizStatistics(),
			]);
		const providerStatistics = mergeStockAnalysisFinvizFields(
			stockAnalysisStatistics,
			finvizStatistics,
			STATISTICS_PROVIDER_POLICIES,
		);
		const merged = mergeAndNormalizeMonetaryFields(providerStatistics, yahoo);
		applySourcePegFallback(merged, [
			{
				source: PEG_SOURCE_STOCKANALYSIS,
				pe_forward: stockAnalysisStatistics.pe_forward,
				peg: stockAnalysisStatistics.peg,
			},
			{
				source: PEG_SOURCE_FINVIZ,
				pe_forward: finvizStatistics.pe_forward,
				peg: finvizStatistics.peg,
			},
		]);
		return completeKnownFamilyRow(merged, family);
	}
	if (family === "financials") {
		const [
			yahoo,
			stockAnalysisStatistics,
			stockAnalysisFinancialsSnapshot,
			finvizStatistics,
		] = await Promise.all([
			bundle.getYahooIndicators(),
			bundle.getStockAnalysisStatistics(),
			bundle.getStockAnalysisFinancials(),
			bundle.getFinvizStatistics(),
		]);
		const stockAnalysisFinancials = {
			...mergeStockAnalysisSnapshots(
				stockAnalysisStatistics,
				stockAnalysisFinancialsSnapshot,
			),
			revenue_growth: stockAnalysisFinancialsSnapshot.revenue_growth ?? null,
			eps_growth: stockAnalysisFinancialsSnapshot.eps_growth ?? null,
			gross_margin:
				stockAnalysisFinancialsSnapshot.gross_margin ??
				stockAnalysisStatistics.gross_margin ??
				null,
			operating_margin:
				stockAnalysisFinancialsSnapshot.operating_margin ??
				stockAnalysisStatistics.operating_margin ??
				null,
		};
		const merged = {
			...mergeStockAnalysisFinvizFields(
				stockAnalysisFinancials,
				finvizStatistics,
				FINANCIALS_PROVIDER_POLICIES,
			),
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

/** Refresh, merge, cache, and persist one stat family through the shared lifecycle. */
async function refreshAndPersistFamily({
	bundle,
	store,
	ticker,
	family,
	persistedRow,
	stockEntry,
	refreshedAt = Date.now(),
}: {
	bundle: ProviderBundle;
	store: BackendStore;
	ticker: string;
	family: StatsFamily;
	persistedRow: Record<string, unknown>;
	stockEntry: StockEntry | null;
	refreshedAt?: number;
}): Promise<PersistedFamilyRefresh> {
	const refreshedRow = await refreshFamilyRow(bundle, family);
	const mergedIndicators = mergeFamilyRow(
		persistedRow,
		family,
		refreshedRow,
		refreshedAt,
	);
	const mergedFamilyRow = familyRow(mergedIndicators, family);
	familyCaches[family].set(ticker, {
		value: mergedFamilyRow,
		updatedAt: refreshedAt,
		lastFailureAt: null,
	});
	await persistIndicators(store, ticker, mergedIndicators, stockEntry);
	return {
		mergedFamilyRow,
		mergedIndicators,
	};
}

/** Record refresh failure timing so later auto refreshes respect cooldowns. */
function rememberFamilyRefreshFailure(
	ticker: string,
	family: StatsFamily,
	refreshedAt: number,
	previous: FamilyCacheEntry | undefined = familyCaches[family].get(ticker),
): void {
	familyCaches[family].set(ticker, {
		value: previous?.value ?? {},
		updatedAt: previous?.updatedAt ?? refreshedAt,
		lastFailureAt: refreshedAt,
	});
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
			await refreshAndPersistFamily({
				bundle,
				store,
				ticker,
				family,
				persistedRow,
				stockEntry,
				refreshedAt,
			});
		} catch {
			rememberFamilyRefreshFailure(ticker, family, refreshedAt, entry);
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
		const cacheOnlyResolution = policy.stats.cacheOnlyResolution(row);
		return {
			family,
			row,
			decision: cacheOnlyResolution.decision,
			sourceTier: cacheOnlyResolution.sourceTier,
			timestamp: familyTimestamp(persistedRow, family),
			queuedRefresh: false,
		};
	}

	const now = Date.now();
	const cached = chooseCachedSnapshot(ticker, family, persistedRow, now);
	const refreshDecision = policy.stats.familyRefreshDecision({
		mode,
		family,
		cached,
	});
	if (refreshDecision.action === "serve_cache") {
		return {
			family,
			row: cached.row,
			decision: refreshDecision.decision,
			sourceTier: refreshDecision.sourceTier,
			timestamp: cached.timestamp,
			queuedRefresh: false,
		};
	}

	if (refreshDecision.action === "serve_stale_and_queue") {
		return {
			family,
			row: cached.row,
			decision: refreshDecision.decision,
			sourceTier: refreshDecision.sourceTier,
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
		const { mergedIndicators, mergedFamilyRow } = await refreshAndPersistFamily(
			{
				bundle,
				store,
				ticker,
				family,
				persistedRow,
				stockEntry,
				refreshedAt,
			},
		);
		Object.assign(persistedRow, mergedIndicators);
		return {
			family,
			row: mergedFamilyRow,
			decision: "inline_refresh",
			sourceTier: "live",
			timestamp: refreshedAt,
			queuedRefresh: false,
		};
	} catch {
		const previous = familyCaches[family].get(ticker);
		rememberFamilyRefreshFailure(ticker, family, refreshedAt, previous);
		const failureDecision = policy.stats.refreshFailureDecision({
			mode,
			cached,
		});
		if (failureDecision === "throw_live") {
			throw new Error(`Live stats unavailable for ticker: ${ticker}`);
		}
		if (failureDecision === "serve_stale") {
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
