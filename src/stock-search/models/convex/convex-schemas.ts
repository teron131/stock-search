/** Normalize Convex rows to and from local stock models. */

import { normalizeTickerSymbol } from "../../common-utils.js";

export type ConvexStockRow = {
	ticker: string;
	indicators: Record<string, unknown>;
	evaluation: Record<string, unknown>;
	labels: string[];
	updatedAt?: number | null;
};

export type ConvexPortfolioPosition = {
	ticker: string;
	quantity: number;
};

export type ConvexPortfolioRow = {
	key: string;
	positions: ConvexPortfolioPosition[];
	portfolioStats?: Record<string, unknown> | null;
	updatedAt?: number | null;
};

export type ConvexNewsRow = {
	key: string;
	ticker: string;
	row: Record<string, unknown>;
	updatedAt?: number | null;
};

export type ConvexMetaVersionRow = {
	key: string;
	value: string;
	updatedAt?: number | null;
};

/** Normalize Convex portfolio rows into local position dicts. */
export function normalizePortfolioPositions(
	rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	const normalized: Array<Record<string, unknown>> = [];
	for (const row of rows) {
		const ticker = normalizeTickerSymbol(String(row.ticker ?? ""));
		if (!ticker) {
			continue;
		}
		normalized.push({
			ticker,
			quantity: Number(row.quantity ?? 0),
		});
	}
	return normalized;
}

/** Normalize Convex stock rows into the local stock map. */
export function normalizeStockMap(
	rows: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
	const normalized: Record<string, Record<string, unknown>> = {};
	for (const [ticker, row] of Object.entries(rows)) {
		const tickerSymbol = normalizeTickerSymbol(ticker);
		if (!tickerSymbol) {
			continue;
		}
		normalized[tickerSymbol] = {
			ticker: tickerSymbol,
			indicators:
				typeof row.indicators === "object" && row.indicators != null
					? { ...(row.indicators as Record<string, unknown>) }
					: {},
			evaluation:
				typeof row.evaluation === "object" && row.evaluation != null
					? { ...(row.evaluation as Record<string, unknown>) }
					: {},
			labels: Array.isArray(row.labels)
				? row.labels
						.map((label) => String(label).trim())
						.filter(Boolean)
				: [],
		};
	}
	return normalized;
}

/** Convert a Convex payload into the local stock map shape. */
export function payloadToStockMap(
	items: unknown,
): Record<string, Record<string, unknown>> {
	if (!Array.isArray(items)) {
		return {};
	}

	const mapped: Record<string, Record<string, unknown>> = {};
	for (const item of items) {
		if (typeof item !== "object" || item == null) {
			continue;
		}
		const row = item as Record<string, unknown>;
		const ticker = normalizeTickerSymbol(String(row.ticker ?? ""));
		if (!ticker) {
			continue;
		}
		mapped[ticker] = {
			indicators:
				typeof row.indicators === "object" && row.indicators != null
					? { ...(row.indicators as Record<string, unknown>) }
					: {},
			evaluation:
				typeof row.evaluation === "object" && row.evaluation != null
					? { ...(row.evaluation as Record<string, unknown>) }
					: {},
			labels: Array.isArray(row.labels)
				? row.labels
						.map((label) => String(label).trim())
						.filter(Boolean)
				: [],
		};
	}
	return mapped;
}

/** Convert the local stock map into Convex row payloads. */
export function stockMapToRows(
	rows: Record<string, Record<string, unknown>>,
): Array<Record<string, unknown>> {
	return Object.entries(normalizeStockMap(rows)).map(([ticker, row]) => ({
		ticker,
		...row,
	}));
}
