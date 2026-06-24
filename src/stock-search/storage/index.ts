/** Public storage boundary for backend persistence contracts and adapter exports. */

import type { StockAnalysisSectorSnapshot } from "../data-sources/stockanalysis/index.js";
import type { CalibrationStatsRow } from "./schemas.js";

export { D1Store } from "./d1.js";
export { SQLiteStore } from "./sqlite.js";
export type { CalibrationStatsRow };

export type BackendName = "d1" | "sqlite";

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
