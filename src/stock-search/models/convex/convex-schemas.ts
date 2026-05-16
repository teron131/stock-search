/** Normalize Convex rows to and from local stock models. */

import { normalizeTicker } from "../../utils.js";
import { normalizeStockIndicators } from "../schemas.js";

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
	strategy?: string;
	position_source?: string;
	industry_labels?: string[];
	extra?: Record<string, unknown>;
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

export type ConvexSectorSnapshotRow = {
	key: string;
	sectors: Array<Record<string, unknown>>;
	meta: Record<string, unknown>;
	updatedAt?: number | null;
};

export const CONVEX_PORTFOLIO_POSITION_FIELDS = new Set([
	"ticker",
	"quantity",
	"strategy",
	"position_source",
	"industry_labels",
	"extra",
]);

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter(Boolean);
}

function normalizeObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value == null || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

function extraFields(row: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(row)
			.filter(([, value]) => value !== undefined)
			.filter(([key]) => !CONVEX_PORTFOLIO_POSITION_FIELDS.has(key)),
	);
}

function finiteNumberOrZero(value: unknown): number {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}

function trimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Normalize local portfolio rows into Convex-safe position records. */
export function normalizePortfolioPositions(
	rows: Array<Record<string, unknown>>,
): ConvexPortfolioPosition[] {
	const normalized: ConvexPortfolioPosition[] = [];
	for (const row of rows) {
		const ticker = normalizeTicker(String(row.ticker ?? ""));
		if (!ticker) {
			continue;
		}
		const industryLabels = normalizeStringArray(row.industry_labels);
		const strategy = trimmedString(row.strategy);
		const positionSource = trimmedString(row.position_source);
		const extra = { ...normalizeObject(row.extra), ...extraFields(row) };
		normalized.push({
			ticker,
			quantity: finiteNumberOrZero(row.quantity),
			...(strategy ? { strategy } : {}),
			...(positionSource ? { position_source: positionSource } : {}),
			...(industryLabels.length > 0 ? { industry_labels: industryLabels } : {}),
			...(Object.keys(extra).length > 0 ? { extra } : {}),
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
		const tickerSymbol = normalizeTicker(ticker);
		if (!tickerSymbol) {
			continue;
		}
		normalized[tickerSymbol] = {
			ticker: tickerSymbol,
			indicators:
				typeof row.indicators === "object" && row.indicators != null
					? normalizeStockIndicators(row.indicators)
					: {},
			evaluation:
				typeof row.evaluation === "object" && row.evaluation != null
					? { ...(row.evaluation as Record<string, unknown>) }
					: {},
			labels: Array.isArray(row.labels)
				? row.labels.map((label) => String(label).trim()).filter(Boolean)
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
		const ticker = normalizeTicker(String(row.ticker ?? ""));
		if (!ticker) {
			continue;
		}
		mapped[ticker] = {
			indicators:
				typeof row.indicators === "object" && row.indicators != null
					? normalizeStockIndicators(row.indicators)
					: {},
			evaluation:
				typeof row.evaluation === "object" && row.evaluation != null
					? { ...(row.evaluation as Record<string, unknown>) }
					: {},
			labels: Array.isArray(row.labels)
				? row.labels.map((label) => String(label).trim()).filter(Boolean)
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
