/** Keep the evaluation calibration database updated at ticker-row granularity. */

import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { normalizeTicker } from "../utils.js";
import { calibrationDbPath, resetScoreAnchorsCache } from "./anchors.js";

export const CALIBRATION_SCORE_FIELD_NAMES = [
	"market_cap",
	"peg",
	"pe",
	"pe_forward",
	"ps",
	"ps_forward",
	"debt_to_equity",
	"free_cash_flow",
	"shareholder_yield",
	"revenue",
	"revenue_growth",
	"eps_growth",
	"gross_margin",
	"operating_margin",
	"roe",
	"roic",
	"median_upside",
] as const;

const FAMILY_FETCHED_AT_FIELDS = [
	"market_data_fetched_at",
	"market_snapshot_fetched_at",
	"statistics_fetched_at",
	"financials_fetched_at",
	"ratings_fetched_at",
] as const;

const CALIBRATION_STATS_COLUMNS = [
	["ticker", "TEXT PRIMARY KEY"],
	["name", "TEXT"],
	["sector_name", "TEXT"],
	["industry_name", "TEXT"],
	["quote_type", "TEXT"],
	["fx", "TEXT"],
	["price", "REAL"],
	["change", "REAL"],
	["change_percent_1d", "REAL"],
	["market_cap", "REAL"],
	["peg", "REAL"],
	["pe", "REAL"],
	["pe_forward", "REAL"],
	["ps", "REAL"],
	["ps_forward", "REAL"],
	["debt_to_equity", "REAL"],
	["free_cash_flow", "REAL"],
	["shareholder_yield", "REAL"],
	["revenue", "REAL"],
	["revenue_growth", "REAL"],
	["eps_growth", "REAL"],
	["gross_margin", "REAL"],
	["operating_margin", "REAL"],
	["roe", "REAL"],
	["roic", "REAL"],
	["median_upside", "REAL"],
	["is_complete", "INTEGER NOT NULL DEFAULT 0"],
	["missing_score_fields", "TEXT NOT NULL DEFAULT ''"],
	["missing_score_field_count", "INTEGER NOT NULL DEFAULT 0"],
	["market_data_fetched_at", "TEXT"],
	["market_snapshot_fetched_at", "TEXT"],
	["statistics_fetched_at", "TEXT"],
	["financials_fetched_at", "TEXT"],
	["ratings_fetched_at", "TEXT"],
	["last_fetched_at", "TEXT"],
] as const;

const CALIBRATION_STATS_COLUMN_NAMES = CALIBRATION_STATS_COLUMNS.map(
	([columnName]) => columnName,
);

export type CalibrationStockRow = {
	ticker: string;
	indicators?: Record<string, unknown>;
	evaluation?: Record<string, unknown>;
	labels?: string[];
};

type SyncEvaluationCalibrationOptions = {
	dbPath?: string;
	insertMissingRows?: boolean;
	logWarnings?: boolean;
};
type SqlStatement = ReturnType<DatabaseSync["prepare"]>;
type CalibrationStatements = {
	selectStock: SqlStatement;
	upsertStock: SqlStatement;
};
type ExistingCalibrationStock = {
	indicators: Record<string, unknown>;
	evaluation: Record<string, unknown>;
	labels: string[];
};

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

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asText(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function parseTimestamp(value: unknown): number | null {
	const text = asText(value);
	if (!text) {
		return null;
	}
	const timestamp = Date.parse(text);
	return Number.isFinite(timestamp) ? timestamp : null;
}

export function missingCalibrationScoreFields(
	indicators: Record<string, unknown>,
): string[] {
	return CALIBRATION_SCORE_FIELD_NAMES.filter(
		(fieldName) => indicators[fieldName] == null,
	);
}

export function isCompleteCalibrationScoreRow(
	indicators: Record<string, unknown>,
): boolean {
	return missingCalibrationScoreFields(indicators).length === 0;
}

export function latestCalibrationFetchedAt(
	indicators: Record<string, unknown>,
): string | null {
	let latestTimestamp: number | null = null;
	for (const fieldName of FAMILY_FETCHED_AT_FIELDS) {
		const timestamp = parseTimestamp(indicators[fieldName]);
		if (
			timestamp != null &&
			(latestTimestamp == null || timestamp > latestTimestamp)
		) {
			latestTimestamp = timestamp;
		}
	}
	return latestTimestamp == null
		? null
		: new Date(latestTimestamp).toISOString();
}

export function mergeNonNullFields(
	base: Record<string, unknown>,
	overlay: Record<string, unknown>,
): Record<string, unknown> {
	const merged = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		if (value != null) {
			merged[key] = value;
		}
	}
	return merged;
}

export function indicatorsAreNewer(
	incomingIndicators: Record<string, unknown>,
	existingIndicators: Record<string, unknown> | undefined,
): boolean {
	if (!existingIndicators) {
		return true;
	}
	const incomingLatest = parseTimestamp(
		latestCalibrationFetchedAt(incomingIndicators),
	);
	const existingLatest = parseTimestamp(
		latestCalibrationFetchedAt(existingIndicators),
	);
	return (
		incomingLatest != null &&
		(existingLatest == null || incomingLatest > existingLatest)
	);
}

export function ensureCalibrationStatsTable(database: DatabaseSync): void {
	const definitions = CALIBRATION_STATS_COLUMNS.map(
		([columnName, columnType]) => `${columnName} ${columnType}`,
	).join(",\n\t\t\t");
	database.exec(`
		CREATE TABLE IF NOT EXISTS calibration_stats (
			${definitions}
		);
	`);

	const existingColumns = new Set(
		(
			database.prepare("PRAGMA table_info(calibration_stats)").all() as Array<{
				name: string;
			}>
		).map((column) => column.name),
	);
	for (const [columnName, columnType] of CALIBRATION_STATS_COLUMNS) {
		if (existingColumns.has(columnName) || columnName === "ticker") {
			continue;
		}
		database.exec(
			`ALTER TABLE calibration_stats ADD COLUMN ${columnName} ${columnType}`,
		);
	}
	database.exec(`
		CREATE INDEX IF NOT EXISTS calibration_stats_complete_idx
			ON calibration_stats (is_complete, missing_score_field_count);
		CREATE INDEX IF NOT EXISTS calibration_stats_sector_idx
			ON calibration_stats (sector_name);
	`);
}

function ensureCalibrationStocksTable(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS stocks (
			ticker TEXT PRIMARY KEY,
			indicators_json TEXT NOT NULL,
			evaluation_json TEXT NOT NULL,
			labels_json TEXT NOT NULL
		);
	`);
}

function calibrationStatsValues(
	ticker: string,
	indicators: Record<string, unknown>,
): SQLInputValue[] {
	const missingFields = missingCalibrationScoreFields(indicators);
	return [
		ticker,
		asText(indicators.name),
		asText(indicators.sector_name),
		asText(indicators.industry_name),
		asText(indicators.quote_type),
		asText(indicators.fx),
		asNumber(indicators.price),
		asNumber(indicators.change),
		asNumber(indicators.change_percent_1d),
		asNumber(indicators.market_cap),
		asNumber(indicators.peg),
		asNumber(indicators.pe),
		asNumber(indicators.pe_forward),
		asNumber(indicators.ps),
		asNumber(indicators.ps_forward),
		asNumber(indicators.debt_to_equity),
		asNumber(indicators.free_cash_flow),
		asNumber(indicators.shareholder_yield),
		asNumber(indicators.revenue),
		asNumber(indicators.revenue_growth),
		asNumber(indicators.eps_growth),
		asNumber(indicators.gross_margin),
		asNumber(indicators.operating_margin),
		asNumber(indicators.roe),
		asNumber(indicators.roic),
		asNumber(indicators.median_upside),
		missingFields.length === 0 ? 1 : 0,
		missingFields.join(","),
		missingFields.length,
		asText(indicators.market_data_fetched_at),
		asText(indicators.market_snapshot_fetched_at),
		asText(indicators.statistics_fetched_at),
		asText(indicators.financials_fetched_at),
		asText(indicators.ratings_fetched_at),
		latestCalibrationFetchedAt(indicators),
	];
}

function runCalibrationStatsRowUpsert(
	database: DatabaseSync,
	ticker: string,
	indicators: Record<string, unknown>,
): void {
	const placeholders = CALIBRATION_STATS_COLUMN_NAMES.map(() => "?").join(", ");
	const updates = CALIBRATION_STATS_COLUMN_NAMES.filter(
		(columnName) => columnName !== "ticker",
	)
		.map((columnName) => `${columnName} = excluded.${columnName}`)
		.join(", ");
	database
		.prepare(`
			INSERT INTO calibration_stats (${CALIBRATION_STATS_COLUMN_NAMES.join(", ")})
			VALUES (${placeholders})
			ON CONFLICT(ticker) DO UPDATE SET ${updates}
		`)
		.run(...calibrationStatsValues(ticker, indicators));
}

export function upsertCalibrationStatsRow(
	database: DatabaseSync,
	ticker: string,
	indicators: Record<string, unknown>,
): void {
	ensureCalibrationStatsTable(database);
	runCalibrationStatsRowUpsert(database, ticker, indicators);
}

function openWritableCalibrationDatabase(dbPath: string): DatabaseSync {
	const database = new DatabaseSync(dbPath);
	database.exec("PRAGMA journal_mode=WAL");
	database.exec("PRAGMA busy_timeout=250");
	ensureCalibrationStocksTable(database);
	ensureCalibrationStatsTable(database);
	return database;
}

function prepareCalibrationStatements(
	database: DatabaseSync,
): CalibrationStatements {
	return {
		selectStock: database.prepare(`
			SELECT indicators_json, evaluation_json, labels_json
			FROM stocks
			WHERE ticker = ?
		`),
		upsertStock: database.prepare(`
			INSERT INTO stocks (ticker, indicators_json, evaluation_json, labels_json)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(ticker) DO UPDATE SET
				indicators_json = excluded.indicators_json,
				evaluation_json = excluded.evaluation_json,
				labels_json = excluded.labels_json
		`),
	};
}

function loadExistingCalibrationStock(
	statement: SqlStatement,
	ticker: string,
): ExistingCalibrationStock | null {
	const existing = statement.get(ticker) as
		| {
				indicators_json: string;
				evaluation_json: string;
				labels_json: string;
		  }
		| undefined;
	if (!existing) {
		return null;
	}
	return {
		indicators: jsonParse<Record<string, unknown>>(
			existing.indicators_json,
			{},
		),
		evaluation: jsonParse<Record<string, unknown>>(
			existing.evaluation_json,
			{},
		),
		labels: jsonParse<string[]>(existing.labels_json, []).filter(Boolean),
	};
}

function syncEvaluationCalibrationRow(
	database: DatabaseSync,
	statements: CalibrationStatements,
	row: CalibrationStockRow,
	insertMissingRows: boolean,
): boolean {
	const ticker = normalizeTicker(row.ticker);
	if (!ticker || row.indicators == null) {
		return false;
	}
	const existing = loadExistingCalibrationStock(statements.selectStock, ticker);
	if (!existing && !insertMissingRows) {
		return false;
	}
	if (existing && !indicatorsAreNewer(row.indicators, existing.indicators)) {
		return false;
	}

	const indicators = mergeNonNullFields(
		existing?.indicators ?? {},
		row.indicators,
	);
	const evaluation = row.evaluation ?? existing?.evaluation ?? {};
	const labels = row.labels ?? existing?.labels ?? [];
	statements.upsertStock.run(
		ticker,
		jsonStringify(indicators),
		jsonStringify(evaluation),
		jsonStringify(labels),
	);
	runCalibrationStatsRowUpsert(database, ticker, indicators);
	return true;
}

export function syncEvaluationCalibrationRows(
	rows: CalibrationStockRow[],
	options: SyncEvaluationCalibrationOptions = {},
): number {
	const dbPath = path.resolve(options.dbPath ?? calibrationDbPath());
	if (options.insertMissingRows !== true && !existsSync(dbPath)) {
		return 0;
	}
	const database = openWritableCalibrationDatabase(dbPath);
	const statements = prepareCalibrationStatements(database);
	let changedCount = 0;
	database.exec("BEGIN");
	try {
		for (const row of rows) {
			changedCount += syncEvaluationCalibrationRow(
				database,
				statements,
				row,
				options.insertMissingRows === true,
			)
				? 1
				: 0;
		}
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	} finally {
		database.close();
	}

	if (changedCount > 0) {
		resetScoreAnchorsCache();
	}
	return changedCount;
}

export function queueEvaluationCalibrationRowsSync(
	rows: CalibrationStockRow[],
	options: SyncEvaluationCalibrationOptions = {},
): void {
	const syncRows = rows.filter((row) => row.indicators != null);
	if (syncRows.length === 0) {
		return;
	}
	setTimeout(() => {
		try {
			syncEvaluationCalibrationRows(syncRows, options);
		} catch (error) {
			if (options.logWarnings === false) {
				return;
			}
			console.warn(
				"Evaluation calibration sync skipped.",
				error instanceof Error ? error.message : error,
			);
		}
	}, 0);
}
