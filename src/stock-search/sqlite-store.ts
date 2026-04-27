import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { normalizeTicker } from "./utils.js";
import type {
	BackendStore,
	CachedNewsRow,
	PortfolioRecord,
	PositionRow,
	StockEntry,
} from "./api/data-store.js";
import { normalizeSectorSnapshot } from "./data-sources/stockanalysis/sector-cache.js";
import type { StockAnalysisSectorSnapshot } from "./data-sources/stockanalysis/index.js";

const SECTOR_SNAPSHOT_META_KEY = "sector_snapshot";

function jsonParse<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string") {
		return fallback;
	}
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function jsonStringify(value: unknown): string {
	return JSON.stringify(value);
}

export class SQLiteStore implements BackendStore {
	readonly backendName = "sqlite" as const;

	private readonly database: DatabaseSync;

	constructor(dbPath: string) {
		mkdirSync(path.dirname(dbPath), { recursive: true });
		this.database = new DatabaseSync(dbPath);
		this.database.exec("PRAGMA journal_mode=WAL");
		this.ensureSchema();
	}

	async loadPortfolio(_key = "default"): Promise<PortfolioRecord> {
		return {
			positions: await this.loadPositions(),
			portfolioStats: jsonParse<Record<string, unknown> | null>(
				this.database
					.prepare("SELECT value FROM meta WHERE key = ?")
					.get("portfolio_stats")?.value,
				null,
			),
		};
	}

	async savePortfolio({
		positions,
		portfolioStats,
	}: PortfolioRecord): Promise<void> {
		await this.savePositions(positions);
		if (portfolioStats) {
			await this.setMetaValue("portfolio_stats", jsonStringify(portfolioStats));
			return;
		}
		this.database
			.prepare("DELETE FROM meta WHERE key = ?")
			.run("portfolio_stats");
	}

	async loadPositions(): Promise<PositionRow[]> {
		const rows = this.database
			.prepare(
				`
				SELECT payload_json
				FROM positions
				ORDER BY sort_index ASC, ticker ASC
				`,
			)
			.all() as Array<{ payload_json: string }>;

		return rows
			.map((row) => jsonParse<Record<string, unknown>>(row.payload_json, {}))
			.filter((row): row is PositionRow => typeof row.ticker === "string");
	}

	async savePositions(positions: PositionRow[]): Promise<void> {
		const insert = this.database.prepare(
			`
			INSERT INTO positions (ticker, sort_index, payload_json)
			VALUES (?, ?, ?)
			`,
		);
		this.database.exec("DELETE FROM positions");
		for (const [index, position] of positions.entries()) {
			const ticker = normalizeTicker(position.ticker);
			if (!ticker) {
				continue;
			}
			insert.run(ticker, index, jsonStringify({ ...position, ticker }));
		}
	}

	async loadStocks(): Promise<Record<string, StockEntry>> {
		const rows = this.database
			.prepare(
				`
				SELECT ticker, indicators_json, evaluation_json, labels_json
				FROM stocks
				ORDER BY ticker ASC
				`,
			)
			.all() as Array<{
				ticker: string;
				indicators_json: string;
				evaluation_json: string;
				labels_json: string;
			}>;

		const stocks: Record<string, StockEntry> = {};
		for (const row of rows) {
			const ticker = normalizeTicker(row.ticker);
			if (!ticker) {
				continue;
			}
			stocks[ticker] = {
				indicators: jsonParse<Record<string, unknown>>(row.indicators_json, {}),
				evaluation: jsonParse<Record<string, unknown>>(row.evaluation_json, {}),
				labels: jsonParse<string[]>(row.labels_json, []).filter(Boolean),
			};
		}
		return stocks;
	}

	async loadStocksByTickers(tickers: string[]): Promise<Record<string, StockEntry>> {
		const normalizedTickers = [...new Set(tickers.map(normalizeTicker).filter(Boolean))];
		if (normalizedTickers.length === 0) {
			return {};
		}

		const placeholders = normalizedTickers.map(() => "?").join(", ");
		const rows = this.database
			.prepare(
				`
				SELECT ticker, indicators_json, evaluation_json, labels_json
				FROM stocks
				WHERE ticker IN (${placeholders})
				ORDER BY ticker ASC
				`,
			)
			.all(...normalizedTickers) as Array<{
				ticker: string;
				indicators_json: string;
				evaluation_json: string;
				labels_json: string;
			}>;

		const stocks: Record<string, StockEntry> = {};
		for (const row of rows) {
			const ticker = normalizeTicker(row.ticker);
			if (!ticker) {
				continue;
			}
			stocks[ticker] = {
				indicators: jsonParse<Record<string, unknown>>(row.indicators_json, {}),
				evaluation: jsonParse<Record<string, unknown>>(row.evaluation_json, {}),
				labels: jsonParse<string[]>(row.labels_json, []).filter(Boolean),
			};
		}
		return stocks;
	}

	async loadStock(ticker: string): Promise<StockEntry | null> {
		const tickerSymbol = normalizeTicker(ticker);
		if (!tickerSymbol) {
			return null;
		}
		const row = this.database
			.prepare(
				`
				SELECT ticker, indicators_json, evaluation_json, labels_json
				FROM stocks
				WHERE ticker = ?
				`,
			)
			.get(tickerSymbol) as
				| {
						ticker: string;
						indicators_json: string;
						evaluation_json: string;
						labels_json: string;
				  }
				| undefined;

		if (!row) {
			return null;
		}
		return {
			indicators: jsonParse<Record<string, unknown>>(row.indicators_json, {}),
			evaluation: jsonParse<Record<string, unknown>>(row.evaluation_json, {}),
			labels: jsonParse<string[]>(row.labels_json, []).filter(Boolean),
		};
	}

	async upsertStocks(
		rows: Array<{
			ticker: string;
			indicators?: Record<string, unknown>;
			evaluation?: Record<string, unknown>;
			labels?: string[];
		}>,
	): Promise<void> {
		for (const row of rows) {
			const ticker = normalizeTicker(row.ticker);
			if (!ticker) {
				continue;
			}
			const existing = this.database
				.prepare(
					`
					SELECT indicators_json, evaluation_json, labels_json
					FROM stocks
					WHERE ticker = ?
					`,
				)
				.get(ticker) as
					| {
							indicators_json: string;
							evaluation_json: string;
							labels_json: string;
					  }
					| undefined;

			const indicators =
				row.indicators ??
				jsonParse<Record<string, unknown>>(existing?.indicators_json, {});
			const evaluation =
				row.evaluation ??
				jsonParse<Record<string, unknown>>(existing?.evaluation_json, {});
			const labels =
				row.labels ??
				jsonParse<string[]>(existing?.labels_json, []).filter(Boolean);

			this.database
				.prepare(
					`
					INSERT INTO stocks (ticker, indicators_json, evaluation_json, labels_json)
					VALUES (?, ?, ?, ?)
					ON CONFLICT(ticker) DO UPDATE SET
						indicators_json = excluded.indicators_json,
						evaluation_json = excluded.evaluation_json,
						labels_json = excluded.labels_json
					`,
				)
				.run(
					ticker,
					jsonStringify(indicators),
					jsonStringify(evaluation),
					jsonStringify(labels),
				);
		}
	}

	async deleteStocksByTickers(tickers: string[]): Promise<void> {
		const normalizedTickers = [...new Set(tickers.map(normalizeTicker).filter(Boolean))];
		if (normalizedTickers.length === 0) {
			return;
		}

		const placeholders = normalizedTickers.map(() => "?").join(", ");
		this.database
			.prepare(`DELETE FROM stocks WHERE ticker IN (${placeholders})`)
			.run(...normalizedTickers);
	}

	async loadNews(key = "default"): Promise<CachedNewsRow[]> {
		const rows = this.database
			.prepare(
				`
				SELECT key, ticker, row_json, updated_at
				FROM news
				WHERE key = ?
				ORDER BY ticker ASC
				`,
			)
			.all(key) as Array<{
				key: string;
				ticker: string;
				row_json: string;
				updated_at: number;
			}>;

		return rows.map((row) => ({
			key: row.key,
			ticker: normalizeTicker(row.ticker),
			row: jsonParse<Record<string, unknown>>(row.row_json, {}),
			updatedAt: Number(row.updated_at) || 0,
		}));
	}

	async saveNews(rows: CachedNewsRow[], key = "default"): Promise<void> {
		const deleteStatement = this.database.prepare("DELETE FROM news WHERE key = ?");
		const insertStatement = this.database.prepare(
			`
			INSERT INTO news (key, ticker, row_json, updated_at)
			VALUES (?, ?, ?, ?)
			`,
		);
		deleteStatement.run(key);
		for (const row of rows) {
			const ticker = normalizeTicker(row.ticker);
			if (!ticker) {
				continue;
			}
			insertStatement.run(
				key,
				ticker,
				jsonStringify(row.row),
				row.updatedAt || Date.now(),
			);
		}
	}

	async deleteNewsByTickers(tickers: string[], key = "default"): Promise<void> {
		const normalizedTickers = [...new Set(tickers.map(normalizeTicker).filter(Boolean))];
		if (normalizedTickers.length === 0) {
			return;
		}

		const placeholders = normalizedTickers.map(() => "?").join(", ");
		this.database
			.prepare(`DELETE FROM news WHERE key = ? AND ticker IN (${placeholders})`)
			.run(key, ...normalizedTickers);
	}

	async loadSectorSnapshot(_key = "default"): Promise<StockAnalysisSectorSnapshot | null> {
		return normalizeSectorSnapshot(
			jsonParse<unknown>(
				this.database
					.prepare("SELECT value FROM meta WHERE key = ?")
					.get(SECTOR_SNAPSHOT_META_KEY)?.value,
				null,
			),
		);
	}

	async saveSectorSnapshot(
		snapshot: StockAnalysisSectorSnapshot,
		_key = "default",
	): Promise<void> {
		await this.setMetaValue(SECTOR_SNAPSHOT_META_KEY, jsonStringify(snapshot));
	}

	async getMetaValue(key: string): Promise<string | null> {
		const row = this.database
			.prepare("SELECT value FROM meta WHERE key = ?")
			.get(key) as { value?: unknown } | undefined;
		return typeof row?.value === "string" ? row.value : null;
	}

	async setMetaValue(key: string, value: string): Promise<void> {
		this.database
			.prepare(
				`
				INSERT INTO meta (key, value)
				VALUES (?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value
				`,
			)
			.run(key, value);
	}

	private ensureSchema(): void {
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS positions (
				ticker TEXT PRIMARY KEY,
				sort_index INTEGER NOT NULL,
				payload_json TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS stocks (
				ticker TEXT PRIMARY KEY,
				indicators_json TEXT NOT NULL,
				evaluation_json TEXT NOT NULL,
				labels_json TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS news (
				key TEXT NOT NULL,
				ticker TEXT NOT NULL,
				row_json TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (key, ticker)
			);
		`);
	}
}
