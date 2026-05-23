import type { StockAnalysisSectorSnapshot } from "../../data-sources/stockanalysis/index.js";
import { normalizeSectorSnapshot } from "../../data-sources/stockanalysis/sector-cache.js";
import type {
	BackendStore,
	CachedNewsRow,
	PortfolioRecord,
	PositionRow,
	StockEntry,
} from "../../storage/index.js";
import { normalizeTicker } from "../../utils.js";
import { normalizeStockIndicators } from "../schemas.js";
import { ConvexApiError, ConvexHttpClient } from "./client.js";
import {
	CONVEX_PORTFOLIO_POSITION_FIELDS,
	normalizePortfolioPositions,
} from "./convex-schemas.js";
import {
	CONVEX_META_GET,
	CONVEX_META_SET,
	CONVEX_NEWS_DELETE_BY_TICKERS,
	CONVEX_NEWS_LIST,
	CONVEX_NEWS_REPLACE_ALL,
	CONVEX_PORTFOLIO_GET,
	CONVEX_PORTFOLIO_GET_POSITIONS,
	CONVEX_PORTFOLIO_SET,
	CONVEX_PORTFOLIO_SET_POSITIONS,
	CONVEX_REALTIME_TOPICS,
	CONVEX_SECTORS_GET,
	CONVEX_SECTORS_SET,
	CONVEX_STOCK_DELETE_BY_TICKERS,
	CONVEX_STOCK_GET,
	CONVEX_STOCK_GET_MANY,
	CONVEX_STOCK_LIST,
	CONVEX_STOCK_REPLACE_ALL,
	CONVEX_STOCK_UPSERT,
	CONVEX_STOCK_UPSERT_MANY,
} from "./function-names.js";

function normalizeLabels(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((label) => String(label ?? "").trim()).filter(Boolean);
}

function normalizeObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

function trimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extraFields(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, fieldValue]) => fieldValue !== undefined)
			.filter(([key]) => !CONVEX_PORTFOLIO_POSITION_FIELDS.has(key)),
	);
}

function normalizePosition(value: unknown): PositionRow | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const row = value as Record<string, unknown>;
	const ticker = normalizeTicker(row.ticker);
	if (!ticker) {
		return null;
	}
	const position: PositionRow = {
		...normalizeObject(row.extra),
		...extraFields(row),
		ticker,
	};
	const quantity = Number(row.quantity);
	if (Number.isFinite(quantity)) {
		position.quantity = quantity;
	}
	const strategy = trimmedString(row.strategy);
	if (strategy) {
		position.strategy = strategy;
	}
	const positionSource = trimmedString(row.position_source);
	if (positionSource) {
		position.position_source = positionSource;
	}
	const industryLabels = normalizeLabels(row.industry_labels);
	if (industryLabels.length > 0) {
		position.industry_labels = industryLabels;
	}
	return position;
}

function normalizePositionRows(value: unknown): PositionRow[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map(normalizePosition)
		.filter((position): position is PositionRow => position !== null);
}

function normalizeStockEntry(value: unknown): StockEntry | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const row = value as Record<string, unknown>;
	return {
		indicators:
			typeof row.indicators === "object" && row.indicators !== null
				? normalizeStockIndicators(row.indicators)
				: {},
		evaluation:
			typeof row.evaluation === "object" && row.evaluation !== null
				? (row.evaluation as Record<string, unknown>)
				: {},
		labels: normalizeLabels(row.labels),
	};
}

function payloadToStockMap(payload: unknown): Record<string, StockEntry> {
	if (!Array.isArray(payload)) {
		return {};
	}
	const rows: Record<string, StockEntry> = {};
	for (const item of payload) {
		const record =
			typeof item === "object" && item !== null
				? (item as Record<string, unknown>)
				: null;
		const ticker = normalizeTicker(record?.ticker);
		const entry = normalizeStockEntry(record);
		if (!ticker || !entry) {
			continue;
		}
		rows[ticker] = entry;
	}
	return rows;
}

export class ConvexStore implements BackendStore {
	readonly backendName = "convex" as const;

	private readonly client: ConvexHttpClient;

	constructor(baseUrl: string, deployKey: string) {
		this.client = new ConvexHttpClient(baseUrl, deployKey);
	}

	private isMissingFunctionError(error: unknown): boolean {
		return (
			error instanceof ConvexApiError &&
			/Could not find(?: public)? function/.test(String(error.message))
		);
	}

	async loadPortfolio(key = "default"): Promise<PortfolioRecord> {
		const payload = await this.client.query<Record<string, unknown> | null>(
			CONVEX_PORTFOLIO_GET,
			{ key },
		);
		return {
			positions: normalizePositionRows(payload?.positions),
			portfolioStats:
				typeof payload?.portfolioStats === "object" &&
				payload.portfolioStats !== null
					? (payload.portfolioStats as Record<string, unknown>)
					: null,
		};
	}

	async savePortfolio({
		positions,
		portfolioStats,
		key = "default",
	}: PortfolioRecord & { key?: string }): Promise<void> {
		await this.client.mutation(CONVEX_PORTFOLIO_SET, {
			key,
			positions: normalizePortfolioPositions(positions),
			portfolioStats,
		});
	}

	async savePortfolioStats(
		portfolioStats: Record<string, unknown> | null,
		key = "default",
	): Promise<void> {
		const existing = await this.loadPortfolio(key);
		await this.savePortfolio({
			key,
			positions: existing.positions,
			portfolioStats,
		});
	}

	async loadPositions(): Promise<PositionRow[]> {
		try {
			const payload = await this.client.query<unknown[]>(
				CONVEX_PORTFOLIO_GET_POSITIONS,
				{ key: "default" },
			);
			return normalizePositionRows(payload);
		} catch (error) {
			if (!this.isMissingFunctionError(error)) {
				throw error;
			}
		}

		const portfolio = await this.loadPortfolio();
		return portfolio.positions;
	}

	async savePositions(positions: PositionRow[]): Promise<void> {
		try {
			await this.client.mutation(CONVEX_PORTFOLIO_SET_POSITIONS, {
				key: "default",
				positions: normalizePortfolioPositions(positions),
			});
			return;
		} catch (error) {
			if (!this.isMissingFunctionError(error)) {
				throw error;
			}
		}

		const existing = await this.loadPortfolio();
		await this.savePortfolio({
			positions,
			portfolioStats: existing.portfolioStats,
		});
	}

	async loadStocks(): Promise<Record<string, StockEntry>> {
		return payloadToStockMap(await this.client.query(CONVEX_STOCK_LIST));
	}

	async loadStocksByTickers(
		tickers: string[],
	): Promise<Record<string, StockEntry>> {
		return payloadToStockMap(
			await this.client.query(CONVEX_STOCK_GET_MANY, { tickers }),
		);
	}

	async loadStock(ticker: string): Promise<StockEntry | null> {
		const payload = await this.client.query<Record<string, unknown> | null>(
			CONVEX_STOCK_GET,
			{ ticker },
		);
		return normalizeStockEntry(payload);
	}

	async upsertStocks(
		rows: Array<{
			ticker: string;
			indicators?: Record<string, unknown>;
			evaluation?: Record<string, unknown>;
			labels?: string[];
		}>,
	): Promise<void> {
		if (rows.length === 0) {
			return;
		}
		const normalizedRows = rows.map((row) => ({
			...row,
			indicators:
				row.indicators === undefined
					? undefined
					: normalizeStockIndicators(row.indicators),
		}));
		try {
			await this.client.mutation(CONVEX_STOCK_UPSERT_MANY, {
				rows: normalizedRows,
			});
			return;
		} catch (error) {
			if (!this.isMissingFunctionError(error)) {
				throw error;
			}
		}

		await Promise.all(
			normalizedRows.map((row) =>
				this.client.mutation(CONVEX_STOCK_UPSERT, row),
			),
		);
	}

	async deleteStocksByTickers(tickers: string[]): Promise<void> {
		if (tickers.length === 0) {
			return;
		}
		try {
			await this.client.mutation(CONVEX_STOCK_DELETE_BY_TICKERS, { tickers });
			return;
		} catch (error) {
			if (!this.isMissingFunctionError(error)) {
				throw error;
			}
		}

		const rows =
			await this.client.query<Record<string, unknown>[]>(CONVEX_STOCK_LIST);
		const removed = new Set(tickers.map(normalizeTicker).filter(Boolean));
		await this.client.mutation(CONVEX_STOCK_REPLACE_ALL, {
			rows: rows.filter((row) => !removed.has(normalizeTicker(row?.ticker))),
		});
	}

	async loadNews(key = "default"): Promise<CachedNewsRow[]> {
		const payload = await this.client.query<unknown[]>(CONVEX_NEWS_LIST, {
			key,
		});
		if (!Array.isArray(payload)) {
			return [];
		}
		return payload
			.filter((row) => typeof row === "object" && row !== null)
			.map((row) => row as Record<string, unknown>)
			.map((row) => ({
				key: String(row.key ?? key),
				ticker: normalizeTicker(row.ticker),
				row:
					typeof row.row === "object" && row.row !== null
						? (row.row as Record<string, unknown>)
						: {},
				updatedAt: Number(row.updatedAt) || 0,
			}));
	}

	async saveNews(rows: CachedNewsRow[], key = "default"): Promise<void> {
		await this.client.mutation(CONVEX_NEWS_REPLACE_ALL, {
			key,
			rows,
		});
	}

	async deleteNewsByTickers(tickers: string[], key = "default"): Promise<void> {
		if (tickers.length === 0) {
			return;
		}
		try {
			await this.client.mutation(CONVEX_NEWS_DELETE_BY_TICKERS, {
				key,
				tickers,
			});
			return;
		} catch (error) {
			if (!this.isMissingFunctionError(error)) {
				throw error;
			}
		}

		const rows = await this.loadNews(key);
		const removed = new Set(tickers.map(normalizeTicker).filter(Boolean));
		await this.saveNews(
			rows.filter((row) => !removed.has(normalizeTicker(row.ticker))),
			key,
		);
	}

	async loadSectorSnapshot(
		key = "default",
	): Promise<StockAnalysisSectorSnapshot | null> {
		try {
			return normalizeSectorSnapshot(
				await this.client.query(CONVEX_SECTORS_GET, { key }),
			);
		} catch (error) {
			if (this.isMissingFunctionError(error)) {
				return null;
			}
			throw error;
		}
	}

	async saveSectorSnapshot(
		snapshot: StockAnalysisSectorSnapshot,
		key = "default",
	): Promise<void> {
		await this.client.mutation(CONVEX_SECTORS_SET, {
			key,
			sectors: snapshot.sectors,
			meta: snapshot.meta,
		});
	}

	async getMetaValue(key: string): Promise<string | null> {
		const payload = await this.client.query<Record<string, unknown> | null>(
			CONVEX_META_GET,
			{ key },
		);
		return typeof payload?.value === "string" ? payload.value : null;
	}

	async setMetaValue(key: string, value: string): Promise<void> {
		await this.client.mutation(CONVEX_META_SET, { key, value });
	}
}

export const convexRealtimeTopics = [...CONVEX_REALTIME_TOPICS];
