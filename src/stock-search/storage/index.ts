/** Public storage boundary for backend persistence contracts and store creation. */

import { appConfig, type BackendName } from "../api/config.js";
import type { StockAnalysisSectorSnapshot } from "../data-sources/stockanalysis/index.js";
import { setCalibrationStatsRows } from "../evaluation/anchors.js";
import { queueEvaluationCalibrationRowsSync } from "../evaluation/calibration-db.js";
import { D1Store } from "./d1.js";
import type { CalibrationStatsRow } from "./schemas.js";
import { SQLiteStore } from "./sqlite.js";

export type { CalibrationStatsRow };
export { D1Store, SQLiteStore };

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
	loadCalibrationStats(): Promise<CalibrationStatsRow[]>;
	upsertCalibrationStatsRows(rows: CalibrationStatsRow[]): Promise<void>;
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

export function createLazyStore(): BackendStore {
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
			const store = getStore();
			await store.upsertStocks(rows);
			const stocks = await store.loadStocksByTickers(
				rows.map((row) => row.ticker),
			);
			queueEvaluationCalibrationRowsSync(
				Object.entries(stocks).map(([ticker, stock]) => ({
					ticker,
					indicators: stock.indicators,
					evaluation: stock.evaluation,
					labels: stock.labels,
				})),
				{ store },
			);
		},
		deleteStocksByTickers(tickers) {
			return getStore().deleteStocksByTickers(tickers);
		},
		loadCalibrationStats() {
			return getStore().loadCalibrationStats();
		},
		upsertCalibrationStatsRows(rows) {
			return getStore().upsertCalibrationStatsRows(rows);
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

export function createStore(): BackendStore {
	if (appConfig.dataStoreBackend === "d1") {
		return new D1Store(
			appConfig.d1AccountId,
			appConfig.d1DatabaseId,
			appConfig.d1ApiToken,
		);
	}
	return new SQLiteStore(appConfig.dataSqlitePath);
}

export function getStore(): BackendStore {
	cachedStore ??= createStore();
	return cachedStore;
}

export async function verifyStoreStartup(
	store: BackendStore = getStore(),
): Promise<void> {
	if (appConfig.dataStoreBackend === "d1") {
		await store.getMetaValue("stats_generated_at");
	}
	setCalibrationStatsRows(await store.loadCalibrationStats());
}
