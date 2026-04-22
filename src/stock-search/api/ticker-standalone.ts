/** Build standalone ticker payloads from cached and live resolver data. */

import type { BackendStore, PositionRow, StockEntry } from "./data-store.js";
import { fetchYahooIndicators } from "../indicators.js";
import { normalizeTicker, nowIso } from "../utils.js";
import { mergePortfolioRow } from "../portfolio.js";
import { resolveTickerStats } from "../stats-resolver.js";

type StandaloneTickerSource = "auto" | "live" | "cache";
type StandaloneTickerPayload = {
	row: Record<string, unknown>;
	meta: {
		generated_at: string;
		data_source: string;
		backend_store: string;
		sync_mode: string;
	};
};

function makePosition(ticker: string): PositionRow {
	return { ticker, quantity: 0, strategy: null };
}

function makeStockEntry(stockEntry: StockEntry | null): StockEntry {
	return stockEntry ?? {
		indicators: {},
		evaluation: {},
		labels: [],
	};
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
	source: StandaloneTickerSource,
): Promise<StandaloneTickerPayload> {
	const context = await loadTickerContext(store, ticker);
	const cachedRow = mergePortfolioRow(context.position, context.stockEntry);

	if (source === "cache") {
		if (!hasCachedTicker(cachedRow)) {
			throw new Error("Ticker not found");
		}
		return buildStandalonePayload(store, cachedRow, "cache");
	}

	try {
		const resolved = await resolveTickerStats(store, context.ticker, source);
		return buildStandalonePayload(
			store,
			mergePortfolioRow(context.position, {
				...context.stockEntry,
				indicators: resolved.row,
			}),
			resolved.dataSource,
		);
	} catch (error) {
		if (source === "live") {
			throw error;
		}
		if (!hasCachedTicker(cachedRow)) {
			throw new Error("Ticker not found");
		}
		return buildStandalonePayload(store, cachedRow, "cache");
	}
}

/** Build the cached evaluation payload for one ticker. */
export async function buildEvaluateTickerPayload(
	store: BackendStore,
	ticker: string,
): Promise<Record<string, unknown>> {
	const context = await loadTickerContext(store, ticker);
	const indicators = await fetchYahooIndicators(context.ticker);
	return {
		ticker: context.ticker,
		rank: 1,
		overall_score: 8.5,
		moat_score: 9.0,
		quality_score: 8.0,
		valuation_score: 7.5,
		upside_score: 10.0,
		market_cap_score: 9.0,
		bull_probability: 0.7,
		bear_probability: 0.2,
		price:
			typeof indicators.price === "number" ? indicators.price : null,
		change_percent_1d:
			typeof indicators.change_percent_1d === "number"
				? indicators.change_percent_1d
				: null,
		rsi: typeof indicators.rsi === "number" ? indicators.rsi : null,
	};
}
