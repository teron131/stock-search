/** Build ETF-aware public ticker rows from positions, stock entries, and stats refreshes. */

import {
	type EtfResolutionResult,
	type EtfSnapshotResult,
	resolveEtfSnapshotCache,
} from "../etf/index.js";
import type { TickerSource } from "../policy.js";
import { resolveTickerStats } from "../stats-resolver/index.js";
import type {
	BackendStore,
	PositionRow,
	StockEntry,
} from "../storage/index.js";
import { normalizeTicker } from "../utils.js";
import {
	applyEtfProxyStatsToStocks,
	resolveEtfProxyStocks,
} from "./etf-proxy.js";
import { mergePortfolioRow } from "./rows.js";

type TickerRowResult = {
	row: Record<string, unknown>;
	dataSource: string;
};

/** Detect whether cached indicators should trigger ETF snapshot enrichment. */
function hasEtfSnapshotSignal(indicators: Record<string, unknown>): boolean {
	const cachedHoldings = indicators.etf_holdings;
	return (
		String(indicators.quote_type ?? "")
			.trim()
			.toUpperCase() === "ETF" ||
		(Array.isArray(cachedHoldings) && cachedHoldings.length > 0)
	);
}

/** Enrich one stock entry with the latest ETF snapshot when the ticker is ETF-like. */
async function enrichTickerEtfEntry(
	store: BackendStore,
	ticker: string,
	stockEntry: StockEntry,
): Promise<{
	stockEntry: StockEntry;
	snapshot: EtfSnapshotResult | null;
}> {
	if (!hasEtfSnapshotSignal(stockEntry.indicators)) {
		return { stockEntry, snapshot: null };
	}

	const snapshotCache = await resolveEtfSnapshotCache(ticker, stockEntry, true);
	const snapshotHasData =
		snapshotCache.snapshot.holdings.length > 0 ||
		snapshotCache.snapshot.sectors.length > 0;
	const indicators =
		snapshotCache.refreshedIndicators ??
		(snapshotHasData
			? {
					...stockEntry.indicators,
					quote_type: "ETF",
					etf_holdings: snapshotCache.snapshot.holdings,
					etf_sectors: snapshotCache.snapshot.sectors,
				}
			: { ...stockEntry.indicators, quote_type: "ETF" });

	if (snapshotCache.refreshedIndicators) {
		await store.upsertStocks([
			{
				ticker,
				indicators,
				evaluation: stockEntry.evaluation,
				labels: stockEntry.labels,
			},
		]);
	}

	return {
		stockEntry: {
			...stockEntry,
			indicators,
		},
		snapshot: snapshotCache.snapshot,
	};
}

/** Build the zero-quantity position used for standalone ETF proxy calculations. */
function makeTickerPosition(ticker: string): PositionRow {
	return { ticker, quantity: 0, strategy: null };
}

/** Build the ETF resolution shape needed by the shared proxy calculator. */
function standaloneEtfResolution(
	ticker: string,
	snapshot: EtfSnapshotResult,
): EtfResolutionResult {
	return {
		stockPositions: [],
		etfPositions: [makeTickerPosition(ticker)],
		snapshotByTicker: {
			[ticker]: snapshot,
		},
		etfRefreshedCount: 0,
		cacheChanged: false,
		changedTickers: [],
	};
}

/** Apply ETF proxy stats to one standalone ticker entry when holdings are available. */
async function applyTickerEtfProxyStats(
	store: BackendStore,
	ticker: string,
	stockEntry: StockEntry,
	snapshot: EtfSnapshotResult | null,
): Promise<StockEntry> {
	if (!snapshot || snapshot.holdings.length === 0) {
		return stockEntry;
	}

	const resolution = standaloneEtfResolution(ticker, snapshot);
	const proxyStockResolution = await resolveEtfProxyStocks({
		store,
		resolution,
		knownStocks: {
			[ticker]: stockEntry,
		},
		liveRefresh: true,
		normalRefreshTickers: new Set(),
	});
	return (
		applyEtfProxyStatsToStocks(
			{
				[ticker]: stockEntry,
			},
			resolution,
			proxyStockResolution.stocks,
		)[ticker] ?? stockEntry
	);
}

/** Build one public ticker row and report whether it came from cache or live resolution. */
export async function buildTickerRow({
	store,
	ticker,
	position,
	stockEntry,
	source,
}: {
	store: BackendStore;
	ticker: string;
	position: PositionRow;
	stockEntry: StockEntry;
	source: TickerSource;
}): Promise<TickerRowResult> {
	const tickerSymbol = normalizeTicker(ticker);
	if (!tickerSymbol) {
		throw new Error("Invalid ticker");
	}

	if (source === "cache") {
		return {
			row: mergePortfolioRow(position, stockEntry),
			dataSource: "cache",
		};
	}

	const resolved = await resolveTickerStats(
		store,
		tickerSymbol,
		source,
		stockEntry,
	);
	const etfEntry = await enrichTickerEtfEntry(store, tickerSymbol, {
		...stockEntry,
		indicators: resolved.row,
	});
	const proxiedStockEntry = await applyTickerEtfProxyStats(
		store,
		tickerSymbol,
		etfEntry.stockEntry,
		etfEntry.snapshot,
	);
	return {
		row: mergePortfolioRow(position, proxiedStockEntry),
		dataSource: resolved.dataSource,
	};
}
