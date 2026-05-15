import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	BackendStore,
	CachedNewsRow,
	PortfolioRecord,
	PositionRow,
	StockEntry,
} from "./api/data-store.js";
import type { StockAnalysisSectorSnapshot } from "./data-sources/stockanalysis/index.js";
import { normalizeSectorSnapshot } from "./data-sources/stockanalysis/sector-cache.js";
import { normalizeStockIndicators } from "./models/schemas.js";
import { normalizeTicker } from "./utils.js";

/** Persists grouped stock API records as a wide SQLite table. */
const SECTOR_SNAPSHOT_META_KEY = "sector_snapshot";

type ColumnKind = "real" | "text";
type StockScalarColumn = {
	name: string;
	kind: ColumnKind;
	group: "indicator" | "evaluation";
};
type StockRow = Record<string, unknown> & { ticker: string };

const STOCK_TEXT_INDICATOR_COLUMNS = [
	"name",
	"strategy",
	"quote_type",
	"equity_type",
	"fx",
	"sector_name",
	"industry_name",
	"earning_direction",
	"market_data_fetched_at",
	"market_snapshot_fetched_at",
	"statistics_fetched_at",
	"financials_fetched_at",
	"ratings_fetched_at",
	"industry_labels_fetched_at",
	"etf_holdings_fetched_at",
] as const;

const STOCK_NUMERIC_INDICATOR_COLUMNS = [
	"price",
	"change",
	"change_percent_1d",
	"change_percent_1m",
	"change_percent_3m",
	"change_percent_6m",
	"change_percent_1y",
	"change_percent_mtd",
	"change_percent_ytd",
	"fifty_day_change_percent",
	"one_hundred_day_change_percent",
	"two_hundred_day_change_percent",
	"market_cap",
	"pe",
	"pe_forward",
	"ps",
	"ps_forward",
	"peg",
	"beta",
	"iv",
	"rsi",
	"median_upside",
	"revenue",
	"revenue_growth",
	"revenue_growth_1y",
	"revenue_cagr_3y",
	"eps_growth",
	"fcf_growth_1y",
	"fcf_cagr_3y",
	"gross_margin",
	"gross_margin_median_3y",
	"operating_margin",
	"operating_margin_median_3y",
	"operating_margin_delta_vs_3y",
	"operating_margin_std_3y",
	"roe",
	"roic",
	"debt_to_equity",
	"free_cash_flow",
	"fcf_margin_median_3y",
	"shares_change_1y",
	"shares_change_cagr_3y",
	"shareholder_yield",
	"research_and_development",
	"rd_intensity",
	"rd_knowledge_capital",
] as const;

const STOCK_NUMERIC_EVALUATION_COLUMNS = [
	"overall_score",
	"quality_score",
	"valuation_score",
	"moat_score",
	"upside_score",
	"market_cap_score",
	"tactical_score",
	"bull_probability",
	"bear_probability",
] as const;

const STOCK_EVALUATION_REASON_COLUMNS = [
	["moat_score", "moat_reasons"],
	["quality_score", "quality_reasons"],
	["upside_score", "upside_reasons"],
] as const;

const STOCK_FUTURE_OUTLOOK_COLUMNS = {
	score: "future_score",
	reasons: "future_reasons",
} as const;

const STOCK_SERIALIZED_INDICATOR_COLUMNS = [
	"industry_labels",
	"ratings",
	"etf_holdings",
	"etf_sectors",
] as const;

const STOCK_SCALAR_COLUMNS: readonly StockScalarColumn[] = [
	...STOCK_TEXT_INDICATOR_COLUMNS.map((name) => ({
		name,
		kind: "text" as const,
		group: "indicator" as const,
	})),
	...STOCK_NUMERIC_INDICATOR_COLUMNS.map((name) => ({
		name,
		kind: "real" as const,
		group: "indicator" as const,
	})),
	...STOCK_NUMERIC_EVALUATION_COLUMNS.map((name) => ({
		name,
		kind: "real" as const,
		group: "evaluation" as const,
	})),
];

const STOCK_COLUMN_NAMES = [
	"labels",
	"indicator_extra",
	"evaluation_extra",
	...STOCK_SCALAR_COLUMNS.map((column) => column.name),
	STOCK_FUTURE_OUTLOOK_COLUMNS.score,
	STOCK_FUTURE_OUTLOOK_COLUMNS.reasons,
	...STOCK_EVALUATION_REASON_COLUMNS.map(([, reasonsColumn]) => reasonsColumn),
	...STOCK_SERIALIZED_INDICATOR_COLUMNS,
];
const STOCK_SELECT_COLUMNS = ["ticker", ...STOCK_COLUMN_NAMES].join(", ");

const POSITION_COLUMN_NAMES = new Set([
	"ticker",
	"quantity",
	"strategy",
	"industry_labels",
]);
const STOCK_KNOWN_INDICATOR_FIELDS = new Set([
	...STOCK_TEXT_INDICATOR_COLUMNS,
	...STOCK_NUMERIC_INDICATOR_COLUMNS,
	...STOCK_SERIALIZED_INDICATOR_COLUMNS,
]);
const STOCK_KNOWN_EVALUATION_FIELDS = new Set([
	...STOCK_NUMERIC_EVALUATION_COLUMNS,
	"score",
	"reasons",
]);

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

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter(Boolean);
}

function normalizeRecordArray(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(
		(item): item is Record<string, unknown> =>
			typeof item === "object" && item !== null && !Array.isArray(item),
	);
}

function scoreFromValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return scoreFromValue((value as Record<string, unknown>).score);
	}
	return null;
}

function scalarForColumn(
	value: Record<string, unknown>,
	column: StockScalarColumn,
): string | number | null {
	const fieldValue = value[column.name];
	if (column.kind === "real") {
		return scoreFromValue(fieldValue);
	}
	if (typeof fieldValue === "string") {
		const text = fieldValue.trim();
		return text ? text : null;
	}
	return null;
}

function extraFields(
	value: Record<string, unknown>,
	knownFields: Iterable<string>,
): Record<string, unknown> {
	const known = new Set(knownFields);
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, fieldValue]) => fieldValue !== undefined)
			.filter(([key]) => !known.has(key)),
	);
}

function columnSqlType(kind: ColumnKind): string {
	return kind === "real" ? "REAL" : "TEXT";
}

function serializedIndicatorValue(
	indicators: Record<string, unknown>,
	columnName: string,
): string {
	if (columnName === "industry_labels") {
		return jsonStringify(normalizeStringArray(indicators[columnName]));
	}
	return jsonStringify(normalizeRecordArray(indicators[columnName]));
}

function scoreReasons(value: unknown): string[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return [];
	}
	return normalizeStringArray((value as Record<string, unknown>).reasons);
}

function stockFromRow(row: StockRow): StockEntry {
	const indicators: Record<string, unknown> = jsonParse<
		Record<string, unknown>
	>(row.indicator_extra, {});
	const evaluation: Record<string, unknown> = jsonParse<
		Record<string, unknown>
	>(row.evaluation_extra, {});

	applyScalarColumns(row, indicators, evaluation);
	applyEvaluationReasons(row, evaluation);
	applyFutureOutlook(row, evaluation);
	applySerializedIndicators(row, indicators);

	return {
		indicators: normalizeStockIndicators(indicators),
		evaluation,
		labels: normalizeStringArray(jsonParse<unknown>(row.labels, [])),
	};
}

function applyScalarColumns(
	row: StockRow,
	indicators: Record<string, unknown>,
	evaluation: Record<string, unknown>,
): void {
	for (const column of STOCK_SCALAR_COLUMNS) {
		const value = row[column.name];
		if (value == null) {
			continue;
		}
		if (column.group === "indicator") {
			indicators[column.name] = value;
		} else {
			evaluation[column.name] = value;
		}
	}
}

function applyEvaluationReasons(
	row: StockRow,
	evaluation: Record<string, unknown>,
): void {
	for (const [scoreField, reasonsField] of STOCK_EVALUATION_REASON_COLUMNS) {
		const reasons = normalizeStringArray(
			jsonParse<unknown>(row[reasonsField], []),
		);
		if (reasons.length > 0) {
			evaluation[scoreField] = {
				score: evaluation[scoreField] ?? null,
				reasons,
			};
		}
	}
}

function applyFutureOutlook(
	row: StockRow,
	evaluation: Record<string, unknown>,
): void {
	const futureScore = row[STOCK_FUTURE_OUTLOOK_COLUMNS.score];
	const futureReasons = normalizeStringArray(
		jsonParse<unknown>(row[STOCK_FUTURE_OUTLOOK_COLUMNS.reasons], []),
	);
	if (futureScore != null) {
		evaluation.score = futureScore;
	}
	if (futureReasons.length > 0) {
		evaluation.reasons = futureReasons;
	}
}

function applySerializedIndicators(
	row: StockRow,
	indicators: Record<string, unknown>,
): void {
	for (const columnName of STOCK_SERIALIZED_INDICATOR_COLUMNS) {
		const parsed =
			columnName === "industry_labels"
				? jsonParse<string[]>(row[columnName], [])
				: jsonParse<Array<Record<string, unknown>>>(row[columnName], []);
		if (Array.isArray(parsed) && parsed.length > 0) {
			indicators[columnName] = parsed;
		}
	}
}

function stocksFromRows(rows: StockRow[]): Record<string, StockEntry> {
	const stocks: Record<string, StockEntry> = {};
	for (const row of rows) {
		const ticker = normalizeTicker(row.ticker);
		if (!ticker) {
			continue;
		}
		stocks[ticker] = stockFromRow(row);
	}
	return stocks;
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
		await this.savePortfolioStats(portfolioStats);
	}

	async savePortfolioStats(
		portfolioStats: Record<string, unknown> | null,
	): Promise<void> {
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
				SELECT ticker, quantity, strategy, industry_labels, extra
				FROM positions
				ORDER BY sort_index ASC, ticker ASC
				`,
			)
			.all() as Array<{
			ticker: string;
			quantity: number | null;
			strategy: string | null;
			industry_labels: string | null;
			extra: string | null;
		}>;

		return rows.map((row) => {
			const position: PositionRow = {
				...jsonParse<Record<string, unknown>>(row.extra, {}),
				ticker: normalizeTicker(row.ticker),
			};
			if (row.quantity != null) {
				position.quantity = row.quantity;
			}
			if (row.strategy) {
				position.strategy = row.strategy;
			}
			const industryLabels = normalizeStringArray(
				jsonParse<unknown>(row.industry_labels, []),
			);
			if (industryLabels.length > 0) {
				position.industry_labels = industryLabels;
			}
			return position;
		});
	}

	async savePositions(positions: PositionRow[]): Promise<void> {
		const insert = this.database.prepare(
			`
			INSERT INTO positions (
				ticker,
				sort_index,
				quantity,
				strategy,
				industry_labels,
				extra
			)
			VALUES (?, ?, ?, ?, ?, ?)
			`,
		);
		this.database.exec("DELETE FROM positions");
		for (const [index, position] of positions.entries()) {
			const ticker = normalizeTicker(position.ticker);
			if (!ticker) {
				continue;
			}
			insert.run(
				ticker,
				index,
				this.finiteNumberOrNull(position.quantity),
				this.textOrNull(position.strategy),
				jsonStringify(normalizeStringArray(position.industry_labels)),
				jsonStringify(extraFields(position, POSITION_COLUMN_NAMES)),
			);
		}
	}

	async loadStocks(): Promise<Record<string, StockEntry>> {
		const rows = this.database
			.prepare(
				`
				SELECT ${STOCK_SELECT_COLUMNS}
				FROM stocks
				ORDER BY ticker ASC
				`,
			)
			.all() as StockRow[];

		return stocksFromRows(rows);
	}

	async loadStocksByTickers(
		tickers: string[],
	): Promise<Record<string, StockEntry>> {
		const normalizedTickers = [
			...new Set(tickers.map(normalizeTicker).filter(Boolean)),
		];
		if (normalizedTickers.length === 0) {
			return {};
		}

		const placeholders = normalizedTickers.map(() => "?").join(", ");
		const rows = this.database
			.prepare(
				`
				SELECT ${STOCK_SELECT_COLUMNS}
				FROM stocks
				WHERE ticker IN (${placeholders})
				ORDER BY ticker ASC
				`,
			)
			.all(...normalizedTickers) as StockRow[];

		return stocksFromRows(rows);
	}

	async loadStock(ticker: string): Promise<StockEntry | null> {
		const tickerSymbol = normalizeTicker(ticker);
		if (!tickerSymbol) {
			return null;
		}
		const row = this.database
			.prepare(
				`
				SELECT ${STOCK_SELECT_COLUMNS}
				FROM stocks
				WHERE ticker = ?
				`,
			)
			.get(tickerSymbol) as StockRow | undefined;

		return row ? stockFromRow(row) : null;
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
			const existing = await this.loadStock(ticker);
			const indicators = normalizeStockIndicators(
				row.indicators ?? existing?.indicators ?? {},
			);
			const evaluation = row.evaluation ?? existing?.evaluation ?? {};
			const labels = row.labels ?? existing?.labels ?? [];

			this.upsertStockSync(ticker, indicators, evaluation, labels);
		}
	}

	async deleteStocksByTickers(tickers: string[]): Promise<void> {
		const normalizedTickers = [
			...new Set(tickers.map(normalizeTicker).filter(Boolean)),
		];
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
		const deleteStatement = this.database.prepare(
			"DELETE FROM news WHERE key = ?",
		);
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
		const normalizedTickers = [
			...new Set(tickers.map(normalizeTicker).filter(Boolean)),
		];
		if (normalizedTickers.length === 0) {
			return;
		}

		const placeholders = normalizedTickers.map(() => "?").join(", ");
		this.database
			.prepare(`DELETE FROM news WHERE key = ? AND ticker IN (${placeholders})`)
			.run(key, ...normalizedTickers);
	}

	async loadSectorSnapshot(
		_key = "default",
	): Promise<StockAnalysisSectorSnapshot | null> {
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
		this.migrateLegacyPositionsTable();
		this.migrateLegacyStocksTable();
		this.ensurePositionsSchema();
		this.ensureStocksSchema();
		this.migrateOverNormalizedPositions();
		this.migrateOverNormalizedStocks();
		this.database.exec(`
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

	private ensurePositionsSchema(): void {
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS positions (
				ticker TEXT PRIMARY KEY,
				sort_index INTEGER NOT NULL,
				quantity REAL,
				strategy TEXT,
				industry_labels TEXT NOT NULL DEFAULT '[]',
				extra TEXT NOT NULL DEFAULT '{}'
			);
		`);
		this.addMissingColumn("positions", "quantity", "REAL");
		this.addMissingColumn("positions", "strategy", "TEXT");
		this.addMissingColumn(
			"positions",
			"industry_labels",
			"TEXT NOT NULL DEFAULT '[]'",
		);
		this.addMissingColumn("positions", "extra", "TEXT NOT NULL DEFAULT '{}'");
	}

	private ensureStocksSchema(): void {
		const definitions = [
			"ticker TEXT PRIMARY KEY",
			"labels TEXT NOT NULL DEFAULT '[]'",
			"indicator_extra TEXT NOT NULL DEFAULT '{}'",
			"evaluation_extra TEXT NOT NULL DEFAULT '{}'",
			...STOCK_SCALAR_COLUMNS.map(
				(column) => `${column.name} ${columnSqlType(column.kind)}`,
			),
			`${STOCK_FUTURE_OUTLOOK_COLUMNS.score} REAL`,
			`${STOCK_FUTURE_OUTLOOK_COLUMNS.reasons} TEXT NOT NULL DEFAULT '[]'`,
			...STOCK_EVALUATION_REASON_COLUMNS.map(
				([, reasonsColumn]) => `${reasonsColumn} TEXT NOT NULL DEFAULT '[]'`,
			),
			...STOCK_SERIALIZED_INDICATOR_COLUMNS.map(
				(columnName) => `${columnName} TEXT NOT NULL DEFAULT '[]'`,
			),
		].join(",\n\t\t\t\t");
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS stocks (
				${definitions}
			);
		`);
		this.addMissingColumn("stocks", "labels", "TEXT NOT NULL DEFAULT '[]'");
		this.addMissingColumn(
			"stocks",
			"indicator_extra",
			"TEXT NOT NULL DEFAULT '{}'",
		);
		this.addMissingColumn(
			"stocks",
			"evaluation_extra",
			"TEXT NOT NULL DEFAULT '{}'",
		);
		for (const column of STOCK_SCALAR_COLUMNS) {
			this.addMissingColumn("stocks", column.name, columnSqlType(column.kind));
		}
		this.addMissingColumn("stocks", STOCK_FUTURE_OUTLOOK_COLUMNS.score, "REAL");
		this.addMissingColumn(
			"stocks",
			STOCK_FUTURE_OUTLOOK_COLUMNS.reasons,
			"TEXT NOT NULL DEFAULT '[]'",
		);
		for (const [, reasonsColumn] of STOCK_EVALUATION_REASON_COLUMNS) {
			this.addMissingColumn(
				"stocks",
				reasonsColumn,
				"TEXT NOT NULL DEFAULT '[]'",
			);
		}
		for (const columnName of STOCK_SERIALIZED_INDICATOR_COLUMNS) {
			this.addMissingColumn("stocks", columnName, "TEXT NOT NULL DEFAULT '[]'");
		}
	}

	private finiteNumberOrNull(value: unknown): number | null {
		const number = Number(value);
		return Number.isFinite(number) ? number : null;
	}

	private textOrNull(value: unknown): string | null {
		return typeof value === "string" && value.trim() ? value.trim() : null;
	}

	private addMissingColumn(
		tableName: string,
		columnName: string,
		columnDefinition: string,
	): void {
		if (
			!this.tableExists(tableName) ||
			this.tableColumns(tableName).has(columnName)
		) {
			return;
		}
		this.database.exec(
			`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`,
		);
	}

	private runTransaction(work: () => void): void {
		this.database.exec("BEGIN");
		try {
			work();
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	private migrateLegacyPositionsTable(): void {
		const columns = this.tableColumns("positions");
		if (!columns.has("payload_json")) {
			return;
		}
		const rows = this.database
			.prepare(
				`
				SELECT ticker, sort_index, payload_json
				FROM positions
				ORDER BY sort_index ASC, ticker ASC
				`,
			)
			.all() as Array<{
			ticker: string;
			sort_index: number;
			payload_json: string;
		}>;
		const positions = rows
			.map((row) => ({
				sortIndex: row.sort_index,
				payload: jsonParse<Record<string, unknown>>(row.payload_json, {
					ticker: row.ticker,
				}),
			}))
			.filter(({ payload }) => typeof payload.ticker === "string");

		this.runTransaction(() => {
			this.database.exec("DROP TABLE positions");
			this.ensurePositionsSchema();
			const insert = this.database.prepare(
				`
				INSERT INTO positions (
					ticker,
					sort_index,
					quantity,
					strategy,
					industry_labels,
					extra
				)
				VALUES (?, ?, ?, ?, ?, ?)
				`,
			);
			for (const { payload, sortIndex } of positions) {
				const ticker = normalizeTicker(payload.ticker);
				if (!ticker) {
					continue;
				}
				insert.run(
					ticker,
					sortIndex,
					this.finiteNumberOrNull(payload.quantity),
					this.textOrNull(payload.strategy),
					jsonStringify(normalizeStringArray(payload.industry_labels)),
					jsonStringify(extraFields(payload, POSITION_COLUMN_NAMES)),
				);
			}
		});
	}

	private migrateLegacyStocksTable(): void {
		const columns = this.tableColumns("stocks");
		if (!columns.has("indicators_json") && !columns.has("evaluation_json")) {
			return;
		}
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
		const entries = rows.map((row) => ({
			ticker: normalizeTicker(row.ticker),
			indicators: normalizeStockIndicators(
				jsonParse<Record<string, unknown>>(row.indicators_json, {}),
			),
			evaluation: jsonParse<Record<string, unknown>>(row.evaluation_json, {}),
			labels: jsonParse<string[]>(row.labels_json, []).filter(Boolean),
		}));
		this.runTransaction(() => {
			this.database.exec("DROP TABLE stocks");
			this.ensureStocksSchema();
			for (const entry of entries) {
				if (!entry.ticker) {
					continue;
				}
				this.upsertStockSync(
					entry.ticker,
					entry.indicators,
					entry.evaluation,
					entry.labels,
				);
			}
		});
	}

	private upsertStockSync(
		ticker: string,
		indicators: Record<string, unknown>,
		evaluation: Record<string, unknown>,
		labels: string[],
	): void {
		const columns = ["ticker", ...STOCK_COLUMN_NAMES];
		const placeholders = columns.map(() => "?").join(", ");
		const updates = STOCK_COLUMN_NAMES.map(
			(columnName) => `${columnName} = excluded.${columnName}`,
		).join(", ");
		const values = [
			ticker,
			jsonStringify(normalizeStringArray(labels)),
			jsonStringify(extraFields(indicators, STOCK_KNOWN_INDICATOR_FIELDS)),
			jsonStringify(extraFields(evaluation, STOCK_KNOWN_EVALUATION_FIELDS)),
			...STOCK_SCALAR_COLUMNS.map((column) =>
				scalarForColumn(
					column.group === "indicator" ? indicators : evaluation,
					column,
				),
			),
			scoreFromValue(evaluation.score),
			jsonStringify(normalizeStringArray(evaluation.reasons)),
			...STOCK_EVALUATION_REASON_COLUMNS.map(([scoreField]) =>
				jsonStringify(scoreReasons(evaluation[scoreField])),
			),
			...STOCK_SERIALIZED_INDICATOR_COLUMNS.map((columnName) =>
				serializedIndicatorValue(indicators, columnName),
			),
		];

		this.database
			.prepare(
				`
				INSERT INTO stocks (${columns.join(", ")})
				VALUES (${placeholders})
				ON CONFLICT(ticker) DO UPDATE SET ${updates}
				`,
			)
			.run(...values);
	}

	private migrateOverNormalizedPositions(): void {
		if (!this.tableExists("position_industry_labels")) {
			return;
		}
		this.runTransaction(() => {
			const rows = this.database
				.prepare(
					`
					SELECT ticker, label
					FROM position_industry_labels
					ORDER BY ticker ASC, sort_index ASC
					`,
				)
				.all() as Array<{ ticker: string; label: string }>;
			const labelsByTicker: Record<string, string[]> = {};
			for (const row of rows) {
				const ticker = normalizeTicker(row.ticker);
				if (!ticker) {
					continue;
				}
				labelsByTicker[ticker] ??= [];
				labelsByTicker[ticker].push(row.label);
			}
			const update = this.database.prepare(
				"UPDATE positions SET industry_labels = ? WHERE ticker = ?",
			);
			for (const [ticker, labels] of Object.entries(labelsByTicker)) {
				update.run(jsonStringify(labels), ticker);
			}
			this.database.exec("DROP TABLE position_industry_labels");
		});
	}

	private migrateOverNormalizedStocks(): void {
		const tableNames = [
			"stock_labels",
			"stock_industry_labels",
			"stock_ratings",
			"stock_etf_holdings",
			"stock_etf_sectors",
		];
		if (!tableNames.some((tableName) => this.tableExists(tableName))) {
			return;
		}
		this.runTransaction(() => {
			this.copyStringListTableToStockColumn("stock_labels", "labels");
			this.copyStringListTableToStockColumn(
				"stock_industry_labels",
				"industry_labels",
			);
			this.copyRecordTableToStockColumn("stock_ratings", "ratings", (row) => ({
				date: row.date,
				epoch_grade_date: row.epoch_grade_date,
				firm: row.firm,
				to_grade: row.to_grade,
				from_grade: row.from_grade,
				action: row.action,
				price_target_action: row.price_target_action,
				current_price_target: row.current_price_target,
				prior_price_target: row.prior_price_target,
			}));
			this.copyRecordTableToStockColumn(
				"stock_etf_holdings",
				"etf_holdings",
				(row) => ({
					ticker: row.holding_ticker,
					name: row.name,
					weight: row.weight,
				}),
			);
			this.copyRecordTableToStockColumn(
				"stock_etf_sectors",
				"etf_sectors",
				(row) => ({
					name: row.name,
					weight: row.weight,
				}),
			);
			for (const tableName of tableNames) {
				if (this.tableExists(tableName)) {
					this.database.exec(`DROP TABLE ${tableName}`);
				}
			}
		});
	}

	private copyStringListTableToStockColumn(
		tableName: string,
		columnName: string,
	): void {
		if (!this.tableExists(tableName)) {
			return;
		}
		const rows = this.database
			.prepare(
				`
				SELECT ticker, label
				FROM ${tableName}
				ORDER BY ticker ASC, sort_index ASC
				`,
			)
			.all() as Array<{ ticker: string; label: string }>;
		const valuesByTicker: Record<string, string[]> = {};
		for (const row of rows) {
			const ticker = normalizeTicker(row.ticker);
			if (!ticker) {
				continue;
			}
			valuesByTicker[ticker] ??= [];
			valuesByTicker[ticker].push(row.label);
		}
		const update = this.database.prepare(
			`UPDATE stocks SET ${columnName} = ? WHERE ticker = ?`,
		);
		for (const [ticker, values] of Object.entries(valuesByTicker)) {
			update.run(jsonStringify(values), ticker);
		}
	}

	private copyRecordTableToStockColumn(
		tableName: string,
		columnName: string,
		mapRow: (row: Record<string, unknown>) => Record<string, unknown>,
	): void {
		if (!this.tableExists(tableName)) {
			return;
		}
		const rows = this.database
			.prepare(
				`
				SELECT *
				FROM ${tableName}
				ORDER BY ticker ASC, sort_index ASC
				`,
			)
			.all() as Array<Record<string, unknown> & { ticker: string }>;
		const valuesByTicker: Record<string, Array<Record<string, unknown>>> = {};
		for (const row of rows) {
			const ticker = normalizeTicker(row.ticker);
			if (!ticker) {
				continue;
			}
			valuesByTicker[ticker] ??= [];
			valuesByTicker[ticker].push(this.compactRecord(mapRow(row)));
		}
		const update = this.database.prepare(
			`UPDATE stocks SET ${columnName} = ? WHERE ticker = ?`,
		);
		for (const [ticker, values] of Object.entries(valuesByTicker)) {
			update.run(jsonStringify(values), ticker);
		}
	}

	private compactRecord(
		record: Record<string, unknown>,
	): Record<string, unknown> {
		return Object.fromEntries(
			Object.entries(record).filter(([, value]) => value != null),
		);
	}

	private tableExists(tableName: string): boolean {
		const row = this.database
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(tableName);
		return row != null;
	}

	private tableColumns(tableName: string): Set<string> {
		if (!this.tableExists(tableName)) {
			return new Set();
		}
		return new Set(
			(
				this.database
					.prepare(`PRAGMA table_info(${tableName})`)
					.all() as Array<{
					name: string;
				}>
			).map((column) => column.name),
		);
	}
}
