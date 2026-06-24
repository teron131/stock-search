/** Build standalone ticker payloads from cached and live resolver data. */

import { policy, type TickerSource } from "./policy.js";
import { buildTickerRow } from "./portfolio/ticker-row.js";
import type { BackendStore, PositionRow, StockEntry } from "./storage/index.js";
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

/** Create the zero-quantity fallback position for standalone ticker requests. */
function makePosition(ticker: string): PositionRow {
	return { ticker, quantity: 0, strategy: null };
}

/** Normalize a possibly missing stock row into the shape expected by row builders. */
function makeStockEntry(stockEntry: StockEntry | null): StockEntry {
	return (
		stockEntry ?? {
			indicators: {},
			evaluation: {},
			labels: [],
		}
	);
}

/** Build metadata for standalone ticker responses. */
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

/** Wrap a public ticker row with standalone response metadata. */
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

/** Detect whether a built row represents a usable cached ticker response. */
function hasCachedTicker(row: Record<string, unknown>): boolean {
	return Boolean(row.ticker);
}

/** Build a payload from a loaded ticker context and enforce the cached-row invariant. */
async function buildPayloadFromContext({
	store,
	ticker,
	context,
	source,
}: {
	store: BackendStore;
	ticker: string;
	context: {
		position: PositionRow;
		stockEntry: StockEntry;
	};
	source: TickerSource;
}): Promise<StandaloneTickerPayload> {
	const result = await buildTickerRow({
		store,
		ticker,
		position: context.position,
		stockEntry: context.stockEntry,
		source,
	});
	if (!hasCachedTicker(result.row)) {
		throw new Error("Ticker not found");
	}
	return buildStandalonePayload(store, result.row, result.dataSource);
}

/** Load portfolio and cache context needed to build one standalone ticker row. */
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
		return buildPayloadFromContext({
			store,
			ticker: tickerSymbol,
			context,
			source,
		});
	}

	try {
		const context = await contextPromise;
		return await buildPayloadFromContext({
			store,
			ticker: tickerSymbol,
			context,
			source,
		});
	} catch (error) {
		if (source === "live") {
			throw error;
		}
		const context = await contextPromise;
		return buildPayloadFromContext({
			store,
			ticker: tickerSymbol,
			context,
			source: "cache",
		});
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
		policy.request.defaultTickerSource,
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
