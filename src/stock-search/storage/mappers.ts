/** Map between app-level storage objects and normalized SQL row values. */

import type {
	StockAnalysisSectorSnapshot,
	StockAnalysisSectorSummary,
} from "../data-sources/stockanalysis/index.js";
import { normalizeSectorSnapshot } from "../data-sources/stockanalysis/sector-cache.js";
import { NewsArticleSchema, StockIndicatorsSchema } from "../models/schemas.js";
import { normalizeTicker } from "../utils.js";
import type { CachedNewsRow, PositionRow, StockEntry } from "./index.js";
import {
	DEFAULT_STORAGE_KEY,
	NEWS_FIELD_COLUMNS,
	NEWS_KNOWN_FIELDS,
	NEWS_KNOWN_METADATA_FIELDS,
	NEWS_METADATA_COLUMNS,
	PORTFOLIO_STAT_COLUMNS,
	POSITION_COLUMN_NAMES,
	STOCK_COLUMN_NAMES,
	STOCK_EVALUATION_REASON_COLUMNS,
	STOCK_FUTURE_OUTLOOK_COLUMNS,
	STOCK_NUMERIC_EVALUATION_COLUMNS,
	STOCK_NUMERIC_INDICATOR_COLUMNS,
	STOCK_SCALAR_COLUMNS,
	STOCK_SERIALIZED_INDICATOR_COLUMNS,
	STOCK_TEXT_INDICATOR_COLUMNS,
	type StockScalarColumn,
	type StorageValue,
} from "./schemas.js";

export type StockRow = Record<string, unknown> & { ticker: string };

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
const StoredNewsArticleSchema = NewsArticleSchema.passthrough();

export function jsonParse<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string") {
		return fallback;
	}
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

export function jsonStringify(value: unknown): string {
	return JSON.stringify(value);
}

export function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter(Boolean);
}

export function normalizeRecordArray(
	value: unknown,
): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(
		(item): item is Record<string, unknown> =>
			typeof item === "object" && item !== null && !Array.isArray(item),
	);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function finiteNumberOrNull(value: unknown): number | null {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

export function scoreFromValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (isRecord(value)) {
		return scoreFromValue(value.score);
	}
	return null;
}

export function extraFields(
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

function scalarForColumn(
	value: Record<string, unknown>,
	column: StockScalarColumn,
): StorageValue {
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
	if (!isRecord(value)) {
		return [];
	}
	return normalizeStringArray(value.reasons);
}

function stockFieldValues(
	indicators: Record<string, unknown>,
	evaluation: Record<string, unknown>,
	labels: string[],
): StorageValue[] {
	return [
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
}

export function stockValues({
	ticker,
	indicators,
	evaluation,
	labels,
	updatedAt,
}: {
	ticker: string;
	indicators: Record<string, unknown>;
	evaluation: Record<string, unknown>;
	labels: string[];
	updatedAt?: number;
}): { columns: string[]; values: StorageValue[] } {
	const columns = ["ticker", ...STOCK_COLUMN_NAMES];
	const normalizedIndicators = StockIndicatorsSchema.parse(indicators);
	const values = [
		ticker,
		...stockFieldValues(normalizedIndicators, evaluation, labels),
	];
	if (updatedAt != null) {
		columns.push("updated_at");
		values.push(updatedAt);
	}
	return { columns, values };
}

export function stockFromRow(row: StockRow): StockEntry {
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
		indicators: StockIndicatorsSchema.parse(indicators),
		evaluation,
		labels: normalizeStringArray(jsonParse<unknown>(row.labels, [])),
	};
}

export function stocksFromRows(rows: StockRow[]): Record<string, StockEntry> {
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

export function positionFromRow(
	row: Record<string, unknown>,
): PositionRow | null {
	const ticker = normalizeTicker(row.ticker);
	if (!ticker) {
		return null;
	}
	const position: PositionRow = {
		...jsonParse<Record<string, unknown>>(row.extra, {}),
		ticker,
	};
	const quantity = finiteNumberOrNull(row.quantity);
	if (quantity != null) {
		position.quantity = quantity;
	}
	const strategy = textOrNull(row.strategy);
	if (strategy) {
		position.strategy = strategy;
	}
	const industryLabels = normalizeStringArray(
		jsonParse<unknown>(row.industry_labels, []),
	);
	if (industryLabels.length > 0) {
		position.industry_labels = industryLabels;
	}
	return position;
}

export function positionValues({
	key,
	position,
	sortIndex,
}: {
	key: string;
	position: PositionRow;
	sortIndex: number;
}): StorageValue[] | null {
	const ticker = normalizeTicker(position.ticker);
	if (!ticker) {
		return null;
	}
	return [
		key,
		ticker,
		sortIndex,
		finiteNumberOrNull(position.quantity),
		textOrNull(position.strategy),
		jsonStringify(normalizeStringArray(position.industry_labels)),
		jsonStringify(extraFields(position, POSITION_COLUMN_NAMES)),
	];
}

export function portfolioStatsFromRow(
	row: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
	if (!row) {
		return null;
	}
	const stats = jsonParse<Record<string, unknown>>(row.extra, {});
	for (const column of PORTFOLIO_STAT_COLUMNS) {
		if (row[column] != null) {
			stats[column] = row[column];
		}
	}
	return Object.keys(stats).length > 0 ? stats : null;
}

export function portfolioStatsValues({
	key,
	portfolioStats,
	updatedAt,
}: {
	key: string;
	portfolioStats: Record<string, unknown>;
	updatedAt: number;
}): { columns: string[]; values: StorageValue[] } {
	const columns = ["key", ...PORTFOLIO_STAT_COLUMNS, "extra", "updated_at"];
	const values: StorageValue[] = [
		key,
		...PORTFOLIO_STAT_COLUMNS.map((column) =>
			finiteNumberOrNull(portfolioStats[column]),
		),
		jsonStringify(extraFields(portfolioStats, PORTFOLIO_STAT_COLUMNS)),
		updatedAt,
	];
	return { columns, values };
}

export function newsFromRow(row: Record<string, unknown>): CachedNewsRow {
	const extra = jsonParse<Record<string, unknown>>(row.row_json, {});
	const payload: Record<string, unknown> = { ...extra };
	for (const column of NEWS_FIELD_COLUMNS) {
		if (row[column] != null) {
			payload[column] = row[column];
		}
	}
	const daysAgo = finiteNumberOrNull(row.days_ago);
	if (daysAgo != null) {
		payload.days_ago = daysAgo;
	}
	const metadataExtra = isRecord(payload.metadata) ? payload.metadata : {};
	const metadata = { ...metadataExtra };
	for (const column of NEWS_METADATA_COLUMNS) {
		const value = row[`metadata_${column}`];
		if (value != null) {
			metadata[column] = value;
		}
	}
	if (Object.keys(metadata).length > 0) {
		payload.metadata = metadata;
	}
	return {
		key: String(row.key ?? DEFAULT_STORAGE_KEY),
		ticker: normalizeTicker(row.ticker),
		row: normalizeNewsPayload(payload),
		updatedAt: Number(row.updated_at) || 0,
	};
}

export function newsValues({
	key,
	row,
	updatedAt,
}: {
	key: string;
	row: CachedNewsRow;
	updatedAt: number;
}): { columns: string[]; values: StorageValue[] } | null {
	const ticker = normalizeTicker(row.ticker);
	if (!ticker) {
		return null;
	}
	const payload = normalizeNewsPayload(row.row);
	const metadata = isRecord(payload.metadata) ? payload.metadata : {};
	const extra = extraFields(payload, NEWS_KNOWN_FIELDS);
	const metadataExtra = extraFields(metadata, NEWS_KNOWN_METADATA_FIELDS);
	if (Object.keys(metadataExtra).length > 0) {
		extra.metadata = metadataExtra;
	}
	const columns = [
		"key",
		"ticker",
		...NEWS_FIELD_COLUMNS,
		"days_ago",
		...NEWS_METADATA_COLUMNS.map((column) => `metadata_${column}`),
		"row_json",
		"updated_at",
	];
	const values: StorageValue[] = [
		key,
		ticker,
		...NEWS_FIELD_COLUMNS.map((column) => textOrNull(payload[column])),
		finiteNumberOrNull(payload.days_ago),
		...NEWS_METADATA_COLUMNS.map((column) => textOrNull(metadata[column])),
		jsonStringify(extra),
		row.updatedAt || updatedAt,
	];
	return { columns, values };
}

function normalizeNewsPayload(value: unknown): Record<string, unknown> {
	const payload = isRecord(value) ? value : {};
	if (typeof payload.url !== "string") {
		return payload;
	}
	const parsed = StoredNewsArticleSchema.safeParse(payload);
	return parsed.success ? { ...parsed.data } : payload;
}

export function sectorRowFromDbRow(
	row: Record<string, unknown>,
): StockAnalysisSectorSummary | null {
	const sector = textOrNull(row.sector);
	const stockCount = finiteNumberOrNull(row.stock_count);
	if (!sector || stockCount == null) {
		return null;
	}
	return {
		sector,
		top_tickers: [
			row.top_ticker_1,
			row.top_ticker_2,
			row.top_ticker_3,
			row.top_ticker_4,
			row.top_ticker_5,
		]
			.map(textOrNull)
			.filter((ticker): ticker is string => ticker != null),
		stock_count: stockCount,
		market_cap: finiteNumberOrNull(row.market_cap),
		pe: finiteNumberOrNull(row.pe),
		profit_margin: finiteNumberOrNull(row.profit_margin),
		change_percent_1d: finiteNumberOrNull(row.change_percent_1d),
		change_percent_1y: finiteNumberOrNull(row.change_percent_1y),
	};
}

export function sectorSnapshotFromRows(
	snapshot: Record<string, unknown> | undefined,
	sectorRows: Array<Record<string, unknown>>,
): StockAnalysisSectorSnapshot | null {
	if (!snapshot) {
		return null;
	}
	return normalizeSectorSnapshot({
		meta: {
			...jsonParse<Record<string, unknown>>(snapshot.extra, {}),
			source: snapshot.source,
			fetched_at: snapshot.fetched_at,
			sector_count: snapshot.sector_count,
		},
		sectors: sectorRows
			.map(sectorRowFromDbRow)
			.filter(
				(sector): sector is StockAnalysisSectorSummary => sector !== null,
			),
	});
}

export function sectorSnapshotHeaderValues({
	key,
	snapshot,
	updatedAt,
}: {
	key: string;
	snapshot: StockAnalysisSectorSnapshot;
	updatedAt: number;
}): StorageValue[] {
	const meta: Record<string, unknown> = isRecord(snapshot.meta)
		? snapshot.meta
		: {};
	return [
		key,
		textOrNull(meta.source),
		textOrNull(meta.fetched_at),
		finiteNumberOrNull(meta.sector_count),
		jsonStringify(extraFields(meta, ["source", "fetched_at", "sector_count"])),
		updatedAt,
	];
}

export function sectorRowValues({
	key,
	sector,
	sortIndex,
}: {
	key: string;
	sector: StockAnalysisSectorSummary;
	sortIndex: number;
}): StorageValue[] {
	const topTickers = normalizeStringArray(sector.top_tickers);
	return [
		key,
		sector.sector,
		sortIndex,
		topTickers[0] ?? null,
		topTickers[1] ?? null,
		topTickers[2] ?? null,
		topTickers[3] ?? null,
		topTickers[4] ?? null,
		finiteNumberOrNull(sector.stock_count),
		finiteNumberOrNull(sector.market_cap),
		finiteNumberOrNull(sector.pe),
		finiteNumberOrNull(sector.profit_margin),
		finiteNumberOrNull(sector.change_percent_1d),
		finiteNumberOrNull(sector.change_percent_1y),
		jsonStringify(
			extraFields(sector, [
				"sector",
				"top_tickers",
				"stock_count",
				"market_cap",
				"pe",
				"profit_margin",
				"change_percent_1d",
				"change_percent_1y",
			]),
		),
	];
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
