/** Refresh and apply portfolio industry labels. */

import type {
	BackendStore,
	PositionRow,
	StockEntry,
} from "../api/data-store.js";
import { isCacheTimestampFresh } from "../cache.js";
import { agetLabels } from "../labeler.js";
import { normalizeTicker } from "../utils.js";
import {
	LABEL_CACHE_MAX_AGE_MS,
	LABEL_FETCHED_AT_FIELD,
	normalizeLabels,
	PORTFOLIO_LABEL_FIELD,
	portfolioTickers,
} from "./shared.js";

function computeMissingLabels(
	tickers: string[],
	stocksMap: Record<string, StockEntry>,
	now: number,
): string[] {
	return tickers.filter((ticker) => {
		const stockEntry = stocksMap[ticker];
		const labels = normalizeLabels(
			stockEntry?.indicators[PORTFOLIO_LABEL_FIELD] ?? stockEntry?.labels,
		);
		const labelsAreFresh = isCacheTimestampFresh(
			stockEntry?.indicators[LABEL_FETCHED_AT_FIELD],
			now,
			LABEL_CACHE_MAX_AGE_MS,
		);
		return labels.length === 0 || !labelsAreFresh;
	});
}

export async function resolvePortfolioLabels(
	store: BackendStore,
	positions: PositionRow[],
	stocksMap: Record<string, StockEntry>,
	fetchMissing: boolean,
): Promise<Record<string, string[]>> {
	const tickers = portfolioTickers(positions);
	if (tickers.length === 0) {
		return {};
	}

	const now = Date.now();
	const labelsByTicker: Record<string, string[]> = {};
	for (const ticker of tickers) {
		const stockEntry = stocksMap[ticker];
		labelsByTicker[ticker] = normalizeLabels(
			stockEntry?.indicators[PORTFOLIO_LABEL_FIELD] ?? stockEntry?.labels,
		);
	}

	const missing = fetchMissing
		? computeMissingLabels(tickers, stocksMap, now)
		: [];
	if (missing.length === 0) {
		return labelsByTicker;
	}

	const fetched = await agetLabels(missing, { maxConcurrency: 4 });
	const upserts: Array<{
		ticker: string;
		indicators?: Record<string, unknown>;
		evaluation?: Record<string, unknown>;
		labels?: string[];
	}> = [];
	for (const ticker of missing) {
		const result = fetched[ticker];
		const labels = normalizeLabels(result?.labels ?? []);
		if (labels.length === 0) {
			continue;
		}
		labelsByTicker[ticker] = labels;
		const existing = stocksMap[ticker];
		const indicators = {
			...(existing?.indicators ?? {}),
			[PORTFOLIO_LABEL_FIELD]: labels,
			[LABEL_FETCHED_AT_FIELD]: new Date(now).toISOString(),
		};
		stocksMap[ticker] = {
			indicators,
			evaluation: existing?.evaluation ?? {},
			labels,
		};
		upserts.push({
			ticker,
			indicators,
			evaluation: existing?.evaluation ?? {},
			labels,
		});
	}

	if (upserts.length > 0) {
		await store.upsertStocks(upserts);
	}

	return labelsByTicker;
}

export function applyPositionLabels(
	positions: PositionRow[],
	labelsByTicker: Record<string, string[]>,
): void {
	for (const position of positions) {
		const ticker = normalizeTicker(position.ticker);
		if (!ticker) {
			continue;
		}
		position[PORTFOLIO_LABEL_FIELD] = normalizeLabels(labelsByTicker[ticker]);
	}
}
