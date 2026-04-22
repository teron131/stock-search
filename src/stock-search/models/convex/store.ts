import { normalizeTicker } from "../../utils.js";
import { ConvexApiError, ConvexHttpClient } from "./client.js";
import {
	CONVEX_META_GET,
	CONVEX_META_SET,
	CONVEX_NEWS_LIST,
	CONVEX_NEWS_REPLACE_ALL,
	CONVEX_PORTFOLIO_GET,
	CONVEX_PORTFOLIO_SET,
	CONVEX_REALTIME_TOPICS,
	CONVEX_STOCK_GET,
	CONVEX_STOCK_GET_MANY,
	CONVEX_STOCK_LIST,
	CONVEX_STOCK_UPSERT,
	CONVEX_STOCK_UPSERT_MANY,
} from "./function-names.js";
import type {
	BackendStore,
	CachedNewsRow,
	PortfolioRecord,
	PositionRow,
	StockEntry,
} from "../../api/data-store.js";

function normalizeLabels(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((label) => String(label ?? "").trim())
		.filter(Boolean);
}

function normalizeStockEntry(value: unknown): StockEntry | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const row = value as Record<string, unknown>;
	return {
		indicators:
			typeof row.indicators === "object" && row.indicators !== null
				? (row.indicators as Record<string, unknown>)
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

	async loadPortfolio(key = "default"): Promise<PortfolioRecord> {
		const payload = await this.client.query<Record<string, unknown> | null>(
			CONVEX_PORTFOLIO_GET,
			{ key },
		);
		const positions = Array.isArray(payload?.positions)
			? (payload.positions.filter(
					(row) => typeof row === "object" && row !== null,
			  ) as PositionRow[])
			: [];
		return {
			positions,
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
			positions,
			portfolioStats,
		});
	}

	async loadPositions(): Promise<PositionRow[]> {
		const portfolio = await this.loadPortfolio();
		return portfolio.positions;
	}

	async savePositions(positions: PositionRow[]): Promise<void> {
		const existing = await this.loadPortfolio();
		await this.savePortfolio({
			positions,
			portfolioStats: existing.portfolioStats,
		});
	}

	async loadStocks(): Promise<Record<string, StockEntry>> {
		return payloadToStockMap(await this.client.query(CONVEX_STOCK_LIST));
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
		try {
			await this.client.mutation(CONVEX_STOCK_UPSERT_MANY, { rows });
			return;
		} catch (error) {
			if (
				!(error instanceof ConvexApiError) ||
				!String(error.message).includes("Could not find function")
			) {
				throw error;
			}
		}

		for (const row of rows) {
			await this.client.mutation(CONVEX_STOCK_UPSERT, row);
		}
	}

	async loadNews(key = "default"): Promise<CachedNewsRow[]> {
		const payload = await this.client.query<unknown[]>(CONVEX_NEWS_LIST, { key });
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
