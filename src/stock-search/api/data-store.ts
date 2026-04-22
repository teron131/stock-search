/** Read and persist portfolio data through SQLite or Convex backends. */

import { appConfig, type BackendName } from "./config.js";
import { ConvexApiError } from "../models/convex/client.js";
import { ConvexStore, convexRealtimeTopics } from "../models/convex/store.js";
import { SQLiteStore } from "../sqlite-store.js";

export type PositionRow = Record<string, unknown> & {
	ticker: string;
	quantity?: number;
};

export type StockEntry = {
	indicators: Record<string, unknown>;
	evaluation: Record<string, unknown>;
	labels: string[];
};

export type PortfolioRecord = {
	positions: PositionRow[];
	portfolioStats: Record<string, unknown> | null;
};

export type CachedNewsRow = {
	key: string;
	ticker: string;
	row: Record<string, unknown>;
	updatedAt: number;
};

export interface BackendStore {
	backendName: BackendName;
	loadPortfolio(key?: string): Promise<PortfolioRecord>;
	savePortfolio(input: PortfolioRecord & { key?: string }): Promise<void>;
	loadPositions(): Promise<PositionRow[]>;
	savePositions(positions: PositionRow[]): Promise<void>;
	loadStocks(): Promise<Record<string, StockEntry>>;
	loadStock(ticker: string): Promise<StockEntry | null>;
	upsertStocks(
		rows: Array<{
			ticker: string;
			indicators?: Record<string, unknown>;
			evaluation?: Record<string, unknown>;
			labels?: string[];
		}>,
	): Promise<void>;
	loadNews(key?: string): Promise<CachedNewsRow[]>;
	saveNews(rows: CachedNewsRow[], key?: string): Promise<void>;
	getMetaValue(key: string): Promise<string | null>;
	setMetaValue(key: string, value: string): Promise<void>;
}

let cachedStore: BackendStore | null = null;

export { convexRealtimeTopics };

class FallbackConvexStore implements BackendStore {
	readonly backendName = "convex" as const;

	constructor(
		private readonly convexStore: ConvexStore,
		private readonly sqliteStore: SQLiteStore,
	) {}

	private async readOrFallback<T>(
		operation: string,
		loader: () => Promise<T>,
		fallback: () => Promise<T>,
	): Promise<T> {
		try {
			return await loader();
		} catch (error) {
			if (!(error instanceof Error || error instanceof ConvexApiError)) {
				throw error;
			}
			console.warn(`Convex ${operation} read failed, using SQLite fallback.`, error);
			return fallback();
		}
	}

	loadPortfolio(key?: string): Promise<PortfolioRecord> {
		return this.readOrFallback(
			"portfolio",
			() => this.convexStore.loadPortfolio(key),
			() => this.sqliteStore.loadPortfolio(key),
		);
	}

	savePortfolio(input: PortfolioRecord & { key?: string }): Promise<void> {
		return this.convexStore.savePortfolio(input);
	}

	loadPositions(): Promise<PositionRow[]> {
		return this.readOrFallback(
			"positions",
			() => this.convexStore.loadPositions(),
			() => this.sqliteStore.loadPositions(),
		);
	}

	savePositions(positions: PositionRow[]): Promise<void> {
		return this.convexStore.savePositions(positions);
	}

	loadStocks(): Promise<Record<string, StockEntry>> {
		return this.readOrFallback(
			"stocks",
			() => this.convexStore.loadStocks(),
			() => this.sqliteStore.loadStocks(),
		);
	}

	loadStock(ticker: string): Promise<StockEntry | null> {
		return this.readOrFallback(
			"stock",
			() => this.convexStore.loadStock(ticker),
			() => this.sqliteStore.loadStock(ticker),
		);
	}

	upsertStocks(
		rows: Array<{
			ticker: string;
			indicators?: Record<string, unknown>;
			evaluation?: Record<string, unknown>;
			labels?: string[];
		}>,
	): Promise<void> {
		return this.convexStore.upsertStocks(rows);
	}

	loadNews(key?: string): Promise<CachedNewsRow[]> {
		return this.readOrFallback(
			"news",
			() => this.convexStore.loadNews(key),
			() => this.sqliteStore.loadNews(key),
		);
	}

	saveNews(rows: CachedNewsRow[], key?: string): Promise<void> {
		return this.convexStore.saveNews(rows, key);
	}

	getMetaValue(key: string): Promise<string | null> {
		return this.readOrFallback(
			"meta",
			() => this.convexStore.getMetaValue(key),
			() => this.sqliteStore.getMetaValue(key),
		);
	}

	setMetaValue(key: string, value: string): Promise<void> {
		return this.convexStore.setMetaValue(key, value);
	}
}

export function createStore(): BackendStore {
	if (appConfig.dataStoreBackend === "convex") {
		return new FallbackConvexStore(
			new ConvexStore(appConfig.convexUrl, appConfig.convexDeployKey),
			new SQLiteStore(appConfig.dataSqlitePath),
		);
	}
	return new SQLiteStore(appConfig.dataSqlitePath);
}

export function getStore(): BackendStore {
	cachedStore ??= createStore();
	return cachedStore;
}

export async function backendName(): Promise<BackendName> {
	return getStore().backendName;
}

export async function loadPositions() {
	return getStore().loadPositions();
}

export async function savePositions(positions: PositionRow[]) {
	return getStore().savePositions(positions);
}

export async function loadStocks() {
	return getStore().loadStocks();
}

export async function loadEvalMap() {
	const stocks = await getStore().loadStocks();
	return Object.fromEntries(
		Object.entries(stocks).map(([ticker, stock]) => [ticker, stock.evaluation]),
	);
}

export async function verifyStoreStartup(store: BackendStore = getStore()): Promise<void> {
	if (appConfig.dataStoreBackend !== "convex") {
		return;
	}
	await store.getMetaValue("stats_generated_at");
}
