/** Classify portfolio positions as ETF or stock and resolve ETF snapshots. */

import type {
	BackendStore,
	PositionRow,
	StockEntry,
} from "../api/data-store.js";
import { ETF_QUOTE_TYPE } from "../data-sources/yahoo-finance.js";
import { normalizeTicker } from "../utils.js";
import { loadAnyEtfCache, resolveEtfSnapshotCache } from "./cache.js";
import { isEtfTicker } from "./sources.js";
import type { EtfResolutionResult, EtfSnapshotResult } from "./types.js";

/** Split held positions into ETF and stock groups and resolve ETF snapshots. */
export async function classifyAndResolveEtfs(
	store: BackendStore,
	positions: PositionRow[],
	stockMap: Record<string, StockEntry>,
	allowLiveFetch: boolean,
): Promise<EtfResolutionResult> {
	const stockPositions: PositionRow[] = [];
	const etfPositions: PositionRow[] = [];
	const snapshotByTicker: Record<string, EtfSnapshotResult> = {};
	const now = Date.now();

	const resolvedPositions = await Promise.all(
		positions.map(async (position) => {
			const ticker = normalizeTicker(position.ticker);
			if (!ticker || Number(position.quantity ?? 0) <= 0) {
				return null;
			}

			const stockEntry = stockMap[ticker] ?? null;
			const indicators = stockEntry?.indicators ?? {};
			const etfLike =
				String(indicators.quote_type ?? "")
					.trim()
					.toUpperCase() === ETF_QUOTE_TYPE ||
				(loadAnyEtfCache(indicators)?.holdings.length ?? 0) > 0 ||
				(allowLiveFetch && (await isEtfTicker(ticker, stockEntry)));

			if (!etfLike) {
				return {
					kind: "stock" as const,
					position,
					ticker,
					stockEntry,
					indicators,
				};
			}

			const snapshotCache = await resolveEtfSnapshotCache(
				ticker,
				stockEntry,
				allowLiveFetch,
				now,
			);

			return {
				kind: "etf" as const,
				position,
				ticker,
				stockEntry,
				indicators,
				snapshot: snapshotCache.snapshot,
				refreshedIndicators: snapshotCache.refreshedIndicators,
				didRefresh: snapshotCache.didRefresh,
			};
		}),
	);

	const upserts: Array<{
		ticker: string;
		indicators?: Record<string, unknown>;
		evaluation?: Record<string, unknown>;
		labels?: string[];
	}> = [];
	const changedTickers = new Set<string>();
	let etfRefreshedCount = 0;

	for (const resolved of resolvedPositions) {
		if (!resolved) {
			continue;
		}

		if (resolved.kind === "stock") {
			stockPositions.push(resolved.position);
			if (
				String(resolved.indicators.quote_type ?? "")
					.trim()
					.toUpperCase() !== "EQUITY" &&
				allowLiveFetch
			) {
				upserts.push({
					ticker: resolved.ticker,
					indicators: { ...resolved.indicators, quote_type: "EQUITY" },
					evaluation: resolved.stockEntry?.evaluation ?? {},
					labels: resolved.stockEntry?.labels ?? [],
				});
			}
			continue;
		}

		etfPositions.push(resolved.position);
		snapshotByTicker[resolved.ticker] = resolved.snapshot;

		if (!resolved.didRefresh || !resolved.refreshedIndicators) {
			continue;
		}

		etfRefreshedCount += 1;
		changedTickers.add(resolved.ticker);
		upserts.push({
			ticker: resolved.ticker,
			indicators: resolved.refreshedIndicators,
			evaluation: resolved.stockEntry?.evaluation ?? {},
			labels: resolved.stockEntry?.labels ?? [],
		});
	}

	if (upserts.length > 0) {
		await store.upsertStocks(upserts);
	}

	return {
		stockPositions,
		etfPositions,
		snapshotByTicker,
		etfRefreshedCount,
		cacheChanged: upserts.length > 0,
		changedTickers: [...changedTickers],
	};
}
