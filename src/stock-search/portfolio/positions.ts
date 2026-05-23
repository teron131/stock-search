/** Mutate portfolio positions and clean up removed ticker data. */

import { safeFloat } from "../common-utils.js";
import { fetchYahooIndicators } from "../indicators.js";
import type { BackendStore, PositionRow } from "../storage/index.js";
import { normalizeTicker } from "../utils.js";
import {
	POSITION_SOURCE_DASHBOARD_MANUAL,
	POSITION_SOURCE_DASHBOARD_WATCHLIST,
	POSITION_SOURCE_FIELD,
	portfolioTickers,
} from "./shared.js";

async function forgetRemovedPortfolioTickers(
	store: BackendStore,
	previousTickers: string[],
	nextPositions: PositionRow[],
): Promise<void> {
	const nextTickers = new Set(portfolioTickers(nextPositions));
	const removedTickers = previousTickers.filter(
		(ticker) => !nextTickers.has(ticker),
	);
	if (removedTickers.length === 0) {
		return;
	}

	await Promise.all([
		store.deleteStocksByTickers(removedTickers),
		store.deleteNewsByTickers(removedTickers),
	]);
}

async function savePortfolioPositionsAndForgetRemoved(
	store: BackendStore,
	positions: PositionRow[],
	previousTickers: string[],
): Promise<void> {
	await store.savePositions(positions);
	await forgetRemovedPortfolioTickers(store, previousTickers, positions);
}

async function ensureValidNewTicker(ticker: string): Promise<void> {
	const indicators = await fetchYahooIndicators(ticker);
	if (safeFloat(indicators.price) == null) {
		throw new Error(`Invalid ticker: ${ticker}`);
	}
}

/** Apply a position patch for one ticker. */
export async function patchPortfolioPosition(
	store: BackendStore,
	ticker: string,
	patch: {
		quantity?: number | null;
		strategy?: string | null;
	},
): Promise<Record<string, unknown>> {
	const tickerSymbol = normalizeTicker(ticker);
	if (!tickerSymbol) {
		throw new Error(`Invalid ticker: ${ticker}`);
	}

	const positions = await store.loadPositions();
	const previousTickers = portfolioTickers(positions);
	const index = positions.findIndex(
		(position) => normalizeTicker(position.ticker) === tickerSymbol,
	);
	if (
		index < 0 &&
		patch.quantity === undefined &&
		patch.strategy === undefined
	) {
		throw new Error("Patch payload is empty.");
	}
	const current =
		index >= 0
			? { ...positions[index] }
			: ({ ticker: tickerSymbol } as PositionRow);
	if (index < 0) {
		await ensureValidNewTicker(tickerSymbol);
	}

	if (patch.quantity !== undefined) {
		current.quantity = patch.quantity ?? 0;
		current[POSITION_SOURCE_FIELD] =
			current.quantity > 0
				? POSITION_SOURCE_DASHBOARD_MANUAL
				: POSITION_SOURCE_DASHBOARD_WATCHLIST;
	}
	if (patch.strategy !== undefined) {
		if (patch.strategy === null || patch.strategy === "") {
			delete current.strategy;
		} else {
			current.strategy = patch.strategy;
		}
	}

	if (index >= 0) {
		positions[index] = current;
	} else {
		positions.push(current);
	}
	await savePortfolioPositionsAndForgetRemoved(
		store,
		positions,
		previousTickers,
	);
	return {
		status: "ok",
		ticker: tickerSymbol,
		position: current,
	};
}

/** Remove one ticker from the portfolio positions list. */
export async function removePortfolioPosition(
	store: BackendStore,
	ticker: string,
): Promise<Record<string, unknown>> {
	const tickerSymbol = normalizeTicker(ticker);
	const positions = await store.loadPositions();
	const previousTickers = portfolioTickers(positions);
	const nextPositions = positions.filter(
		(position) => normalizeTicker(position.ticker) !== tickerSymbol,
	);
	await savePortfolioPositionsAndForgetRemoved(
		store,
		nextPositions,
		previousTickers,
	);
	return { status: "ok", ticker: tickerSymbol };
}
