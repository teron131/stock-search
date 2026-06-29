/** Implement BackendStore once for SQL backends using shared schemas and mappers. */

import type { StockAnalysisSectorSnapshot } from "../data-sources/stockanalysis/index.js";
import { normalizeTicker } from "../utils.js";
import type {
	BackendStore,
	CachedNewsRow,
	PortfolioRecord,
	PositionRow,
	StockEntry,
} from "./index.js";
import {
	newsFromRow,
	newsValues,
	portfolioStatsFromRow,
	portfolioStatsValues,
	positionFromRow,
	positionValues,
	type StockRow,
	sectorRowValues,
	sectorSnapshotFromRows,
	sectorSnapshotHeaderValues,
	stocksFromRows,
	stockValues,
} from "./mappers.js";
import {
	CALIBRATION_STATS_COLUMN_NAMES,
	type CalibrationStatsRow,
	DEFAULT_STORAGE_KEY,
	STOCK_SELECT_COLUMNS,
	tableSchemaQueries,
} from "./schemas.js";

export type SqlValue = string | number | null;
export type SqlStatement = {
	sql: string;
	params?: SqlValue[];
};

export abstract class SqlStore implements BackendStore {
	protected constructor(readonly backendName: BackendStore["backendName"]) {}

	async loadPortfolio(key = DEFAULT_STORAGE_KEY): Promise<PortfolioRecord> {
		await this.ready();
		const [portfolioRows, positionRows] = await Promise.all([
			this.query("SELECT * FROM portfolio_stats WHERE key = ?", [key]),
			this.loadPositionRows(key),
		]);
		return {
			positions: positionRows,
			portfolioStats: portfolioStatsFromRow(portfolioRows[0]),
		};
	}

	async savePortfolio({
		key = DEFAULT_STORAGE_KEY,
		positions,
		portfolioStats,
	}: PortfolioRecord & { key?: string }): Promise<void> {
		await this.ready();
		await this.batch([
			this.portfolioStatsStatement(key, portfolioStats),
			{ sql: "DELETE FROM positions WHERE key = ?", params: [key] },
			...positions.flatMap((position, index) =>
				this.positionStatement(key, position, index),
			),
		]);
	}

	async savePortfolioStats(
		portfolioStats: Record<string, unknown> | null,
		key = DEFAULT_STORAGE_KEY,
	): Promise<void> {
		await this.ready();
		await this.batch([this.portfolioStatsStatement(key, portfolioStats)]);
	}

	async loadPositions(key = DEFAULT_STORAGE_KEY): Promise<PositionRow[]> {
		await this.ready();
		return this.loadPositionRows(key);
	}

	async savePositions(
		positions: PositionRow[],
		key = DEFAULT_STORAGE_KEY,
	): Promise<void> {
		await this.ready();
		await this.batch([
			{ sql: "DELETE FROM positions WHERE key = ?", params: [key] },
			...positions.flatMap((position, index) =>
				this.positionStatement(key, position, index),
			),
		]);
	}

	async loadStocks(): Promise<Record<string, StockEntry>> {
		await this.ready();
		return stocksFromRows(
			(await this.query(
				`
				SELECT ${STOCK_SELECT_COLUMNS}
				FROM stocks
				ORDER BY ticker ASC
				`,
			)) as StockRow[],
		);
	}

	async loadStocksByTickers(
		tickers: string[],
	): Promise<Record<string, StockEntry>> {
		await this.ready();
		const normalizedTickers = normalizeTickers(tickers);
		if (normalizedTickers.length === 0) {
			return {};
		}
		return stocksFromRows(
			(await this.query(
				`
				SELECT ${STOCK_SELECT_COLUMNS}
				FROM stocks
				WHERE ticker IN (${placeholders(normalizedTickers)})
				ORDER BY ticker ASC
				`,
				normalizedTickers,
			)) as StockRow[],
		);
	}

	async loadStock(ticker: string): Promise<StockEntry | null> {
		const tickerSymbol = normalizeTicker(ticker);
		if (!tickerSymbol) {
			return null;
		}
		const stocks = await this.loadStocksByTickers([tickerSymbol]);
		return stocks[tickerSymbol] ?? null;
	}

	async upsertStocks(
		rows: Array<{
			ticker: string;
			indicators?: Record<string, unknown>;
			evaluation?: Record<string, unknown>;
			labels?: string[];
		}>,
	): Promise<void> {
		await this.ready();
		const existingStocks = await this.loadStocksByTickers(
			rows.map((row) => row.ticker),
		);
		const statements: SqlStatement[] = [];
		for (const row of rows) {
			const ticker = normalizeTicker(row.ticker);
			if (!ticker) {
				continue;
			}
			const existing = existingStocks[ticker];
			const { columns, values } = stockValues({
				ticker,
				indicators: row.indicators ?? existing?.indicators ?? {},
				evaluation: row.evaluation ?? existing?.evaluation ?? {},
				labels: row.labels ?? existing?.labels ?? [],
				updatedAt: Date.now(),
			});
			statements.push({
				sql: upsertSql("stocks", columns),
				params: values,
			});
		}
		await this.batch(statements);
	}

	async deleteStocksByTickers(tickers: string[]): Promise<void> {
		await this.ready();
		const normalizedTickers = normalizeTickers(tickers);
		if (normalizedTickers.length === 0) {
			return;
		}
		await this.execute(
			`DELETE FROM stocks WHERE ticker IN (${placeholders(normalizedTickers)})`,
			normalizedTickers,
		);
	}

	async loadCalibrationStats(): Promise<CalibrationStatsRow[]> {
		await this.ready();
		return (await this.query(
			`
			SELECT ${CALIBRATION_STATS_COLUMN_NAMES.join(", ")}
			FROM calibration_stats
			ORDER BY ticker ASC
			`,
		)) as CalibrationStatsRow[];
	}

	async upsertCalibrationStatsRows(rows: CalibrationStatsRow[]): Promise<void> {
		await this.ready();
		const statements = rows.flatMap((row) => {
			const ticker = normalizeTicker(row.ticker);
			if (!ticker) {
				return [];
			}
			const params = CALIBRATION_STATS_COLUMN_NAMES.map((column) =>
				column === "ticker" ? ticker : (row[column] ?? null),
			);
			return [
				{
					sql: upsertSql("calibration_stats", CALIBRATION_STATS_COLUMN_NAMES),
					params,
				},
			];
		});
		await this.batch(statements);
	}

	async loadNews(key = DEFAULT_STORAGE_KEY): Promise<CachedNewsRow[]> {
		await this.ready();
		return (
			await this.query(
				`
				SELECT *
				FROM news
				WHERE key = ?
				ORDER BY ticker ASC
				`,
				[key],
			)
		).map(newsFromRow);
	}

	async saveNews(
		rows: CachedNewsRow[],
		key = DEFAULT_STORAGE_KEY,
	): Promise<void> {
		await this.ready();
		await this.batch([
			{ sql: "DELETE FROM news WHERE key = ?", params: [key] },
			...rows.flatMap((row) => this.newsStatement(key, row)),
		]);
	}

	async deleteNewsByTickers(
		tickers: string[],
		key = DEFAULT_STORAGE_KEY,
	): Promise<void> {
		await this.ready();
		const normalizedTickers = normalizeTickers(tickers);
		if (normalizedTickers.length === 0) {
			return;
		}
		await this.execute(
			`DELETE FROM news WHERE key = ? AND ticker IN (${placeholders(normalizedTickers)})`,
			[key, ...normalizedTickers],
		);
	}

	async loadSectorSnapshot(
		key = DEFAULT_STORAGE_KEY,
	): Promise<StockAnalysisSectorSnapshot | null> {
		await this.ready();
		const [snapshotRows, sectorRows] = await Promise.all([
			this.query("SELECT * FROM sector_snapshots WHERE key = ?", [key]),
			this.query(
				`
				SELECT *
				FROM sector_snapshot_sectors
				WHERE key = ?
				ORDER BY sort_index ASC, sector ASC
				`,
				[key],
			),
		]);
		return sectorSnapshotFromRows(snapshotRows[0], sectorRows);
	}

	async saveSectorSnapshot(
		snapshot: StockAnalysisSectorSnapshot,
		key = DEFAULT_STORAGE_KEY,
	): Promise<void> {
		await this.ready();
		await this.batch([
			this.sectorSnapshotHeaderStatement(key, snapshot),
			{
				sql: "DELETE FROM sector_snapshot_sectors WHERE key = ?",
				params: [key],
			},
			...snapshot.sectors.map((sector, index) => ({
				sql: `
					INSERT INTO sector_snapshot_sectors (
						key,
						sector,
						sort_index,
						top_ticker_1,
						top_ticker_2,
						top_ticker_3,
						top_ticker_4,
						top_ticker_5,
						stock_count,
						market_cap,
						pe,
						profit_margin,
						change_percent_1d,
						change_percent_1y,
						extra
					)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`,
				params: sectorRowValues({
					key,
					sector,
					sortIndex: index,
				}),
			})),
		]);
	}

	async getMetaValue(key: string): Promise<string | null> {
		await this.ready();
		const rows = await this.query("SELECT value FROM meta WHERE key = ?", [
			key,
		]);
		const value = rows[0]?.value;
		return typeof value === "string" ? value : null;
	}

	async setMetaValue(key: string, value: string): Promise<void> {
		await this.ready();
		await this.execute(
			`
			INSERT INTO meta (key, value, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET
				value = excluded.value,
				updated_at = excluded.updated_at
			`,
			[key, value, Date.now()],
		);
	}

	async ensureSchema(): Promise<void> {
		await this.ready();
	}

	protected abstract ready(): Promise<void>;
	protected abstract query(
		sql: string,
		params?: SqlValue[],
	): Promise<Array<Record<string, unknown>>>;
	protected abstract execute(sql: string, params?: SqlValue[]): Promise<void>;
	protected abstract batch(statements: SqlStatement[]): Promise<void>;

	protected schemaStatements(): SqlStatement[] {
		return tableSchemaQueries().map((sql) => ({ sql }));
	}

	private async loadPositionRows(key: string): Promise<PositionRow[]> {
		return (
			await this.query(
				`
				SELECT ticker, quantity, strategy, industry_labels, extra
				FROM positions
				WHERE key = ?
				ORDER BY sort_index ASC, ticker ASC
				`,
				[key],
			)
		)
			.map(positionFromRow)
			.filter((position): position is PositionRow => position !== null);
	}

	private portfolioStatsStatement(
		key: string,
		portfolioStats: Record<string, unknown> | null,
	): SqlStatement {
		if (!portfolioStats) {
			return {
				sql: "DELETE FROM portfolio_stats WHERE key = ?",
				params: [key],
			};
		}
		const { columns, values } = portfolioStatsValues({
			key,
			portfolioStats,
			updatedAt: Date.now(),
		});
		return {
			sql: upsertSql("portfolio_stats", columns),
			params: values,
		};
	}

	private positionStatement(
		key: string,
		position: PositionRow,
		sortIndex: number,
	): SqlStatement[] {
		const values = positionValues({
			key,
			position,
			sortIndex,
		});
		if (!values) {
			return [];
		}
		return [
			{
				sql: `
					INSERT INTO positions (
						key,
						ticker,
						sort_index,
						quantity,
						strategy,
						industry_labels,
						extra
					)
					VALUES (?, ?, ?, ?, ?, ?, ?)
				`,
				params: values,
			},
		];
	}

	private newsStatement(key: string, row: CachedNewsRow): SqlStatement[] {
		const normalized = newsValues({
			key,
			row,
			updatedAt: Date.now(),
		});
		if (!normalized) {
			return [];
		}
		return [
			{
				sql: insertSql("news", normalized.columns),
				params: normalized.values,
			},
		];
	}

	private sectorSnapshotHeaderStatement(
		key: string,
		snapshot: StockAnalysisSectorSnapshot,
	): SqlStatement {
		return {
			sql: `
				INSERT INTO sector_snapshots (
					key,
					source,
					fetched_at,
					sector_count,
					extra,
					updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(key) DO UPDATE SET
					source = excluded.source,
					fetched_at = excluded.fetched_at,
					sector_count = excluded.sector_count,
					extra = excluded.extra,
					updated_at = excluded.updated_at
			`,
			params: sectorSnapshotHeaderValues({
				key,
				snapshot,
				updatedAt: Date.now(),
			}),
		};
	}
}

function insertSql(table: string, columns: readonly string[]): string {
	return `
		INSERT INTO ${table} (${columns.join(", ")})
		VALUES (${placeholders(columns)})
	`;
}

function upsertSql(table: string, columns: readonly string[]): string {
	return `
		${insertSql(table, columns)}
		ON CONFLICT(${conflictTarget(columns)}) DO UPDATE SET ${assignments(columns)}
	`;
}

function conflictTarget(columns: readonly string[]): string {
	return columns.includes("key") ? "key" : "ticker";
}

function assignments(columns: readonly string[]): string {
	return columns
		.filter((column) => column !== "key" && column !== "ticker")
		.map((column) => `${column} = excluded.${column}`)
		.join(", ");
}

function placeholders(columns: readonly unknown[]): string {
	return columns.map(() => "?").join(", ");
}

function normalizeTickers(tickers: string[]): string[] {
	return [...new Set(tickers.map(normalizeTicker).filter(Boolean))];
}
