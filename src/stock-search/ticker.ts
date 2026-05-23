/** Build standalone ticker payloads from cached and live resolver data. */

import type {
	BackendStore,
	PositionRow,
	StockEntry,
} from "./api/data-store.js";
import {
	type EtfResolutionResult,
	type EtfSnapshotResult,
	resolveEtfSnapshotCache,
} from "./etf/index.js";
import { DEFAULT_TICKER_SOURCE, type TickerSource } from "./policy.js";
import {
	applyEtfProxyStatsToStocks,
	resolveEtfProxyStocks,
} from "./portfolio/etf-proxy.js";
import { mergePortfolioRow } from "./portfolio/index.js";
import { resolveTickerStats } from "./stats-resolver/index.js";
import { normalizeTicker, nowIso } from "./utils.js";

type StandaloneTickerPayload = {
	row: Record<string, unknown>;
	meta: {
		generated_at: string;
		data_source: string;
		backend_store: string;
		sync_mode: string;
	};
};
type StandaloneEtfEntry = {
	stockEntry: StockEntry;
	snapshot: EtfSnapshotResult | null;
};

function makePosition(ticker: string): PositionRow {
	return { ticker, quantity: 0, strategy: null };
}

function makeStockEntry(stockEntry: StockEntry | null): StockEntry {
	return (
		stockEntry ?? {
			indicators: {},
			evaluation: {},
			labels: [],
		}
	);
}

function buildStandaloneMeta(
	store: BackendStore,
	dataSource: string,
): StandaloneTickerPayload["meta"] {
	return {
		generated_at: nowIso(),
		data_source: dataSource,
		backend_store: store.backendName,
		sync_mode: "realtime_subscription",
	};
}

function buildStandalonePayload(
	store: BackendStore,
	row: Record<string, unknown>,
	dataSource: string,
): StandaloneTickerPayload {
	return {
		row,
		meta: buildStandaloneMeta(store, dataSource),
	};
}

function hasCachedTicker(row: Record<string, unknown>): boolean {
	return Boolean(row.ticker);
}

function hasEtfSnapshotSignal(indicators: Record<string, unknown>): boolean {
	const cachedHoldings = indicators.etf_holdings;
	return (
		String(indicators.quote_type ?? "")
			.trim()
			.toUpperCase() === "ETF" ||
		(Array.isArray(cachedHoldings) && cachedHoldings.length > 0)
	);
}

async function enrichStandaloneEtfEntry(
	store: BackendStore,
	ticker: string,
	stockEntry: StockEntry,
): Promise<StandaloneEtfEntry> {
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

function standaloneEtfResolution(
	ticker: string,
	snapshot: EtfSnapshotResult,
): EtfResolutionResult {
	return {
		stockPositions: [],
		etfPositions: [makePosition(ticker)],
		snapshotByTicker: {
			[ticker]: snapshot,
		},
		etfRefreshedCount: 0,
		cacheChanged: false,
		changedTickers: [],
	};
}

async function applyStandaloneEtfProxyStats(
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

async function loadTickerContext(
	store: BackendStore,
	ticker: string,
): Promise<{
	ticker: string;
	position: PositionRow;
	stockEntry: StockEntry;
}> {
	const tickerSymbol = normalizeTicker(ticker);
	if (!tickerSymbol) {
		throw new Error("Invalid ticker");
	}

	const [positions, stockEntry] = await Promise.all([
		store.loadPositions(),
		store.loadStock(tickerSymbol),
	]);

	return {
		ticker: tickerSymbol,
		position:
			positions.find((row) => normalizeTicker(row.ticker) === tickerSymbol) ??
			makePosition(tickerSymbol),
		stockEntry: makeStockEntry(stockEntry),
	};
}

/** Build the public standalone stats payload for one ticker. */
export async function buildStandaloneTickerPayload(
	store: BackendStore,
	ticker: string,
	source: TickerSource,
): Promise<StandaloneTickerPayload> {
	const tickerSymbol = normalizeTicker(ticker);
	if (!tickerSymbol) {
		throw new Error("Invalid ticker");
	}

	const contextPromise = loadTickerContext(store, tickerSymbol);

	if (source === "cache") {
		const context = await contextPromise;
		const cachedRow = mergePortfolioRow(context.position, context.stockEntry);
		if (!hasCachedTicker(cachedRow)) {
			throw new Error("Ticker not found");
		}
		return buildStandalonePayload(store, cachedRow, "cache");
	}

	try {
		const [context, resolved] = await Promise.all([
			contextPromise,
			contextPromise.then((context) =>
				resolveTickerStats(store, tickerSymbol, source, context.stockEntry),
			),
		]);
		const etfEntry = await enrichStandaloneEtfEntry(store, tickerSymbol, {
			...context.stockEntry,
			indicators: resolved.row,
		});
		const stockEntry = await applyStandaloneEtfProxyStats(
			store,
			tickerSymbol,
			etfEntry.stockEntry,
			etfEntry.snapshot,
		);
		return buildStandalonePayload(
			store,
			mergePortfolioRow(context.position, stockEntry),
			resolved.dataSource,
		);
	} catch (error) {
		if (source === "live") {
			throw error;
		}
		const context = await contextPromise;
		const cachedRow = mergePortfolioRow(context.position, context.stockEntry);
		if (!hasCachedTicker(cachedRow)) {
			throw new Error("Ticker not found");
		}
		return buildStandalonePayload(store, cachedRow, "cache");
	}
}

/** Build a normalized evaluation payload for one ticker. */
export async function buildEvaluateTickerPayload(
	store: BackendStore,
	ticker: string,
): Promise<Record<string, unknown>> {
	const tickerSymbol = normalizeTicker(ticker);
	if (!tickerSymbol) {
		throw new Error("Invalid ticker");
	}

	const { row, meta } = await buildStandaloneTickerPayload(
		store,
		tickerSymbol,
		DEFAULT_TICKER_SOURCE,
	);
	return {
		ticker: tickerSymbol,
		overall_score: row.overall_score ?? null,
		moat_score: row.moat_score ?? null,
		quality_score: row.quality_score ?? null,
		valuation_score: row.valuation_score ?? null,
		upside_score: row.upside_score ?? null,
		market_cap_score: row.market_cap_score ?? null,
		strategy: row.strategy ?? null,
		eval_source: row.eval_source ?? null,
		price: row.price ?? null,
		change_percent_1d: row.change_percent_1d ?? null,
		rsi: row.rsi ?? null,
		meta,
	};
}
