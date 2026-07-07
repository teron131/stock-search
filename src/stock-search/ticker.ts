/** Owns public standalone ticker and evaluate payload assembly from resolver/cache data. */

import {
	type EtfResolutionResult,
	type EtfSnapshotResult,
	resolveEtfSnapshotCache,
} from "./etf/index.js";
import { isEtfTicker } from "./etf/sources.js";
import { policy, type TickerSource } from "./policy.js";
import {
	applyEtfProxyStatsToStocks,
	resolveEtfProxyStocks,
} from "./portfolio/etf-proxy.js";
import { mergePortfolioRow } from "./portfolio/rows.js";
import { resolveTickerStats } from "./stats-resolver/index.js";
import type { BackendStore, PositionRow, StockEntry } from "./storage/index.js";
import { normalizeTicker, nowIso } from "./utils.js";

type LoadedTickerContext = {
	ticker: string;
	position: PositionRow;
	stockEntry: StockEntry;
};

type StandaloneTickerRowResult = {
	row: Record<string, unknown>;
	dataSource: string;
};

type StandaloneTickerPayload = {
	row: Record<string, unknown>;
	meta: {
		generated_at: string;
		data_source: string;
		backend_store: string;
		sync_mode: string;
	};
};

export class InvalidTickerError extends Error {
	readonly input: string;

	constructor(input: string) {
		super(`Invalid ticker: ${input}`);
		this.name = "InvalidTickerError";
		this.input = input;
	}
}

/** Standalone ticker requests use a zero-quantity position when the portfolio lacks the ticker. */
function makeStandalonePosition(ticker: string): PositionRow {
	return { ticker, quantity: 0, strategy: null };
}

/** Missing cached stock rows are represented as empty indicator/evaluation/label buckets. */
function makeStockEntry(stockEntry: StockEntry | null): StockEntry {
	return (
		stockEntry ?? {
			indicators: {},
			evaluation: {},
			labels: [],
		}
	);
}

/** Public standalone responses carry resolver provenance beside the merged row. */
function buildStandalonePayload(
	store: BackendStore,
	row: Record<string, unknown>,
	dataSource: string,
): StandaloneTickerPayload {
	return {
		row,
		meta: {
			generated_at: nowIso(),
			data_source: dataSource,
			backend_store: store.backendName,
			sync_mode: "realtime_subscription",
		},
	};
}

/** ETF enrichment starts from quote type or cached holdings because providers disagree on ETF metadata. */
function hasEtfSnapshotSignal(indicators: Record<string, unknown>): boolean {
	const cachedHoldings = indicators.etf_holdings;
	return (
		String(indicators.quote_type ?? "")
			.trim()
			.toUpperCase() === "ETF" ||
		(Array.isArray(cachedHoldings) && cachedHoldings.length > 0)
	);
}

/** Persist refreshed ETF snapshot indicators when live enrichment supplies richer holdings. */
async function enrichTickerEtfEntry(
	store: BackendStore,
	ticker: string,
	stockEntry: StockEntry,
): Promise<{
	stockEntry: StockEntry;
	snapshot: EtfSnapshotResult | null;
}> {
	if (
		!hasEtfSnapshotSignal(stockEntry.indicators) &&
		!(await isEtfTicker(ticker, stockEntry))
	) {
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

/** Standalone ETF proxying reuses the portfolio proxy shape without portfolio stock positions. */
function standaloneEtfResolution(
	ticker: string,
	snapshot: EtfSnapshotResult,
): EtfResolutionResult {
	return {
		stockPositions: [],
		etfPositions: [makeStandalonePosition(ticker)],
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
async function buildStandaloneTickerRow({
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
}): Promise<StandaloneTickerRowResult> {
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
	const resolvedStockEntry = await applyTickerEtfProxyStats(
		store,
		tickerSymbol,
		etfEntry.stockEntry,
		etfEntry.snapshot,
	);
	return {
		row: mergePortfolioRow(position, resolvedStockEntry),
		dataSource: resolved.dataSource,
	};
}

/** Build a standalone payload from loaded ticker context and enforce the cached-row invariant. */
async function buildStandalonePayloadFromContext({
	store,
	context,
	source,
}: {
	store: BackendStore;
	context: LoadedTickerContext;
	source: TickerSource;
}): Promise<StandaloneTickerPayload> {
	const result = await buildStandaloneTickerRow({
		store,
		ticker: context.ticker,
		position: context.position,
		stockEntry: context.stockEntry,
		source,
	});
	if (!result.row.ticker) {
		throw new Error("Ticker not found");
	}
	return buildStandalonePayload(store, result.row, result.dataSource);
}

/** Load portfolio and cache context needed to build one standalone ticker row. */
async function loadTickerContext(
	store: BackendStore,
	tickerSymbol: string,
	portfolioKey?: string,
): Promise<LoadedTickerContext> {
	const [positions, stockEntry] = await Promise.all([
		store.loadPositions(portfolioKey),
		store.loadStock(tickerSymbol),
	]);

	return {
		ticker: tickerSymbol,
		position:
			positions.find((row) => normalizeTicker(row.ticker) === tickerSymbol) ??
			makeStandalonePosition(tickerSymbol),
		stockEntry: makeStockEntry(stockEntry),
	};
}

/** Build the public standalone stats payload for one ticker. */
export async function buildStandaloneTickerPayload(
	store: BackendStore,
	ticker: string,
	source: TickerSource,
	portfolioKey?: string,
): Promise<StandaloneTickerPayload> {
	const tickerSymbol = normalizeTicker(ticker);
	if (!tickerSymbol) {
		throw new InvalidTickerError(ticker);
	}

	const context = await loadTickerContext(store, tickerSymbol, portfolioKey);

	if (source === "cache") {
		return buildStandalonePayloadFromContext({
			store,
			context,
			source,
		});
	}

	try {
		return await buildStandalonePayloadFromContext({
			store,
			context,
			source,
		});
	} catch (error) {
		if (source === "live") {
			throw error;
		}
		return buildStandalonePayloadFromContext({
			store,
			context,
			source: "cache",
		});
	}
}

/** Build a normalized evaluation payload for one ticker. */
export async function buildEvaluateTickerPayload(
	store: BackendStore,
	ticker: string,
	portfolioKey?: string,
): Promise<Record<string, unknown>> {
	const tickerSymbol = normalizeTicker(ticker);
	if (!tickerSymbol) {
		throw new InvalidTickerError(ticker);
	}

	const { row, meta } = await buildStandaloneTickerPayload(
		store,
		tickerSymbol,
		policy.request.defaultTickerSource,
		portfolioKey,
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
