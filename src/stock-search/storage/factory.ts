/** Read and persist portfolio data through SQLite or Convex backends. */

import { appConfig, type BackendName } from "../api/config.js";
import type { StockAnalysisSectorSnapshot } from "../data-sources/stockanalysis/index.js";
import { queueEvaluationCalibrationRowsSync } from "../evaluation/calibration-db.js";
import { ConvexApiError } from "../models/convex/client.js";
import { ConvexStore, convexRealtimeTopics } from "../models/convex/store.js";
import { SQLiteStore } from "./sqlite.js";

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
	savePortfolioStats(
		portfolioStats: Record<string, unknown> | null,
		key?: string,
	): Promise<void>;
	loadPositions(): Promise<PositionRow[]>;
	savePositions(positions: PositionRow[]): Promise<void>;
	loadStocks(): Promise<Record<string, StockEntry>>;
	loadStocksByTickers(tickers: string[]): Promise<Record<string, StockEntry>>;
	loadStock(ticker: string): Promise<StockEntry | null>;
	upsertStocks(
		rows: Array<{
			ticker: string;
			indicators?: Record<string, unknown>;
			evaluation?: Record<string, unknown>;
			labels?: string[];
		}>,
	): Promise<void>;
	deleteStocksByTickers(tickers: string[]): Promise<void>;
	loadNews(key?: string): Promise<CachedNewsRow[]>;
	saveNews(rows: CachedNewsRow[], key?: string): Promise<void>;
	deleteNewsByTickers(tickers: string[], key?: string): Promise<void>;
	loadSectorSnapshot(key?: string): Promise<StockAnalysisSectorSnapshot | null>;
	saveSectorSnapshot(
		snapshot: StockAnalysisSectorSnapshot,
		key?: string,
	): Promise<void>;
	getMetaValue(key: string): Promise<string | null>;
	setMetaValue(key: string, value: string): Promise<void>;
}

let cachedStore: BackendStore | null = null;

export { convexRealtimeTopics };

function createLazyStore(): BackendStore {
	return {
		get backendName() {
			return getStore().backendName;
		},
		loadPortfolio(key) {
			return getStore().loadPortfolio(key);
		},
		savePortfolio(input) {
			return getStore().savePortfolio(input);
		},
		savePortfolioStats(portfolioStats, key) {
			return getStore().savePortfolioStats(portfolioStats, key);
		},
		loadPositions() {
			return getStore().loadPositions();
		},
		savePositions(positions) {
			return getStore().savePositions(positions);
		},
		loadStocks() {
			return getStore().loadStocks();
		},
		loadStocksByTickers(tickers) {
			return getStore().loadStocksByTickers(tickers);
		},
		loadStock(ticker) {
			return getStore().loadStock(ticker);
		},
		async upsertStocks(rows) {
			await getStore().upsertStocks(rows);
			queueEvaluationCalibrationRowsSync(rows);
		},
		deleteStocksByTickers(tickers) {
			return getStore().deleteStocksByTickers(tickers);
		},
		loadNews(key) {
			return getStore().loadNews(key);
		},
		saveNews(rows, key) {
			return getStore().saveNews(rows, key);
		},
		deleteNewsByTickers(tickers, key) {
			return getStore().deleteNewsByTickers(tickers, key);
		},
		loadSectorSnapshot(key) {
			return getStore().loadSectorSnapshot(key);
		},
		saveSectorSnapshot(snapshot, key) {
			return getStore().saveSectorSnapshot(snapshot, key);
		},
		getMetaValue(key) {
			return getStore().getMetaValue(key);
		},
		setMetaValue(key, value) {
			return getStore().setMetaValue(key, value);
		},
	};
}

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
		mirror?: (value: T) => Promise<void>,
	): Promise<T> {
		try {
			const value = await loader();
			if (mirror) {
				await this.mirrorLocal(operation, () => mirror(value));
			}
			return value;
		} catch (error) {
			if (!(error instanceof Error || error instanceof ConvexApiError)) {
				throw error;
			}
			console.warn(
				`Convex ${operation} read failed, using SQLite fallback.`,
				error,
			);
			return fallback();
		}
	}

	private async mirrorLocal(
		operation: string,
		action: () => Promise<void>,
	): Promise<void> {
		try {
			await action();
		} catch (error) {
			console.warn(`SQLite mirror ${operation} failed.`, error);
		}
	}

	private async writePrimaryAndMirror(
		operation: string,
		writer: () => Promise<void>,
		mirror: () => Promise<void>,
	): Promise<void> {
		await writer();
		await this.mirrorLocal(operation, mirror);
	}

	loadPortfolio(key?: string): Promise<PortfolioRecord> {
		return this.readOrFallback(
			"portfolio",
			() => this.convexStore.loadPortfolio(key),
			() => this.sqliteStore.loadPortfolio(key),
			(portfolio) => this.sqliteStore.savePortfolio(portfolio),
		);
	}

	savePortfolio(input: PortfolioRecord & { key?: string }): Promise<void> {
		return this.writePrimaryAndMirror(
			"portfolio write",
			() => this.convexStore.savePortfolio(input),
			() => this.sqliteStore.savePortfolio(input),
		);
	}

	savePortfolioStats(
		portfolioStats: Record<string, unknown> | null,
		key?: string,
	): Promise<void> {
		return this.writePrimaryAndMirror(
			"portfolio stats write",
			() => this.convexStore.savePortfolioStats(portfolioStats, key),
			() => this.sqliteStore.savePortfolioStats(portfolioStats),
		);
	}

	loadPositions(): Promise<PositionRow[]> {
		return this.readOrFallback(
			"positions",
			() => this.convexStore.loadPositions(),
			() => this.sqliteStore.loadPositions(),
			(positions) => this.sqliteStore.savePositions(positions),
		);
	}

	savePositions(positions: PositionRow[]): Promise<void> {
		return this.writePrimaryAndMirror(
			"positions write",
			() => this.convexStore.savePositions(positions),
			() => this.sqliteStore.savePositions(positions),
		);
	}

	loadStocks(): Promise<Record<string, StockEntry>> {
		return this.readOrFallback(
			"stocks",
			() => this.convexStore.loadStocks(),
			() => this.sqliteStore.loadStocks(),
			(stocks) =>
				this.sqliteStore.upsertStocks(
					Object.entries(stocks).map(([ticker, stock]) => ({
						ticker,
						...stock,
					})),
				),
		);
	}

	loadStocksByTickers(tickers: string[]): Promise<Record<string, StockEntry>> {
		return this.readOrFallback(
			"stocks",
			() => this.convexStore.loadStocksByTickers(tickers),
			() => this.sqliteStore.loadStocksByTickers(tickers),
			(stocks) =>
				this.sqliteStore.upsertStocks(
					Object.entries(stocks).map(([ticker, stock]) => ({
						ticker,
						...stock,
					})),
				),
		);
	}

	loadStock(ticker: string): Promise<StockEntry | null> {
		return this.readOrFallback(
			"stock",
			() => this.convexStore.loadStock(ticker),
			() => this.sqliteStore.loadStock(ticker),
			(stock) =>
				stock
					? this.sqliteStore.upsertStocks([{ ticker, ...stock }])
					: Promise.resolve(),
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
		return this.writePrimaryAndMirror(
			"stocks write",
			() => this.convexStore.upsertStocks(rows),
			() => this.sqliteStore.upsertStocks(rows),
		);
	}

	deleteStocksByTickers(tickers: string[]): Promise<void> {
		return this.writePrimaryAndMirror(
			"stocks delete",
			() => this.convexStore.deleteStocksByTickers(tickers),
			() => this.sqliteStore.deleteStocksByTickers(tickers),
		);
	}

	loadNews(key?: string): Promise<CachedNewsRow[]> {
		return this.readOrFallback(
			"news",
			() => this.convexStore.loadNews(key),
			() => this.sqliteStore.loadNews(key),
			(rows) => this.sqliteStore.saveNews(rows, key),
		);
	}

	saveNews(rows: CachedNewsRow[], key?: string): Promise<void> {
		return this.writePrimaryAndMirror(
			"news write",
			() => this.convexStore.saveNews(rows, key),
			() => this.sqliteStore.saveNews(rows, key),
		);
	}

	deleteNewsByTickers(tickers: string[], key?: string): Promise<void> {
		return this.writePrimaryAndMirror(
			"news delete",
			() => this.convexStore.deleteNewsByTickers(tickers, key),
			() => this.sqliteStore.deleteNewsByTickers(tickers, key),
		);
	}

	loadSectorSnapshot(
		key?: string,
	): Promise<StockAnalysisSectorSnapshot | null> {
		return this.readOrFallback(
			"sector snapshot",
			() => this.convexStore.loadSectorSnapshot(key),
			() => this.sqliteStore.loadSectorSnapshot(key),
			(snapshot) =>
				snapshot
					? this.sqliteStore.saveSectorSnapshot(snapshot, key)
					: Promise.resolve(),
		);
	}

	saveSectorSnapshot(
		snapshot: StockAnalysisSectorSnapshot,
		key?: string,
	): Promise<void> {
		return this.writePrimaryAndMirror(
			"sector snapshot write",
			() => this.convexStore.saveSectorSnapshot(snapshot, key),
			() => this.sqliteStore.saveSectorSnapshot(snapshot, key),
		);
	}

	getMetaValue(key: string): Promise<string | null> {
		return this.readOrFallback(
			"meta",
			() => this.convexStore.getMetaValue(key),
			() => this.sqliteStore.getMetaValue(key),
			(value) =>
				value != null
					? this.sqliteStore.setMetaValue(key, value)
					: Promise.resolve(),
		);
	}

	setMetaValue(key: string, value: string): Promise<void> {
		return this.writePrimaryAndMirror(
			"meta write",
			() => this.convexStore.setMetaValue(key, value),
			() => this.sqliteStore.setMetaValue(key, value),
		);
	}
}

export function createStore(): BackendStore {
	if (appConfig.dataStoreBackend === "convex") {
		if (appConfig.isVercelRuntime) {
			return new ConvexStore(appConfig.convexUrl, appConfig.convexDeployKey);
		}
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

export { createLazyStore };

export async function verifyStoreStartup(
	store: BackendStore = getStore(),
): Promise<void> {
	if (appConfig.dataStoreBackend !== "convex") {
		return;
	}
	await store.getMetaValue("stats_generated_at");
}
