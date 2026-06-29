/** Mutate one portfolio's positions while shared ticker caches stay global. */

import { safeFloat } from "../common-utils.js";
import { YahooFinanceSource } from "../data-sources/yahoo-finance.js";
import type { BackendStore, PositionRow } from "../storage/index.js";
import { normalizeTicker } from "../utils.js";
import {
	POSITION_SOURCE_DASHBOARD_MANUAL,
	POSITION_SOURCE_DASHBOARD_WATCHLIST,
	POSITION_SOURCE_FIELD,
} from "./shared.js";

async function ensureValidNewTicker(ticker: string): Promise<void> {
	const indicators = await new YahooFinanceSource(
		ticker,
	).getIndicatorsSnapshot();
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
	portfolioKey?: string,
): Promise<Record<string, unknown>> {
	const tickerSymbol = normalizeTicker(ticker);
	if (!tickerSymbol) {
		throw new Error(`Invalid ticker: ${ticker}`);
	}

	const positions = await store.loadPositions(portfolioKey);
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
	await store.savePositions(positions, portfolioKey);
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
	portfolioKey?: string,
): Promise<Record<string, unknown>> {
	const tickerSymbol = normalizeTicker(ticker);
	const positions = await store.loadPositions(portfolioKey);
	const nextPositions = positions.filter(
		(position) => normalizeTicker(position.ticker) !== tickerSymbol,
	);
	await store.savePositions(nextPositions, portfolioKey);
	return { status: "ok", ticker: tickerSymbol };
}
