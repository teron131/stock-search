import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ExaLoadAgent } from "llm-harness-js/agents";

import { StockAnalysisSource } from "../src/stock-search/data-sources/stockanalysis/index.js";
import { calibrationDbPath } from "../src/stock-search/evaluation/anchors.js";
import {
	type CalibrationStockRow,
	ensureCalibrationStatsTable,
	indicatorsAreNewer,
	isCompleteCalibrationScoreRow,
	mergeNonNullFields,
	CALIBRATION_SCORE_FIELD_NAMES as SCORE_FIELD_NAMES,
	syncEvaluationCalibrationRows,
	upsertCalibrationStatsRow,
} from "../src/stock-search/evaluation/calibration-db.js";
import {
	resolveTickerStats,
	type StatsResolutionMode,
} from "../src/stock-search/stats-resolver/index.js";
import { SQLiteStore } from "../src/stock-search/storage/sqlite.js";
import { normalizeTicker, nowIso } from "../src/stock-search/utils.js";

const DEFAULT_LIST_URL = "https://stockanalysis.com/list/sp-500-stocks/";
const FALLBACK_LIST_URL =
	"https://datahub.io/core/s-and-p-500-companies/_r/-/data/constituents.csv";
const DEFAULT_APP_DB_PATH = path.resolve("data/stock_search.db");
const DEFAULT_BATCH_SIZE = 25;

type ScriptOptions = {
	appDbPath: string;
	batchSize: number;
	dbPath: string;
	force: boolean;
	limit: number | null;
	listUrl: string;
	missingOnly: boolean;
	mode: StatsResolutionMode;
	schemaOnly: boolean;
	tickers: string[];
	stockAnalysisPsOnly: boolean;
};

type TickerList = {
	sourceKind:
		| "stockanalysis-direct"
		| "stockanalysis-exa"
		| "csv-fallback"
		| "manual";
	sourceUrl: string;
	tickers: string[];
};

function parseArgs(argv: string[]): ScriptOptions {
	const options: ScriptOptions = {
		appDbPath: process.env.APP_SQLITE_PATH
			? path.resolve(process.env.APP_SQLITE_PATH)
			: DEFAULT_APP_DB_PATH,
		batchSize: DEFAULT_BATCH_SIZE,
		dbPath: process.env.CALIBRATION_SQLITE_PATH
			? path.resolve(process.env.CALIBRATION_SQLITE_PATH)
			: calibrationDbPath(),
		force: false,
		limit: null,
		listUrl: DEFAULT_LIST_URL,
		missingOnly: false,
		mode: "auto",
		schemaOnly: false,
		tickers: [],
		stockAnalysisPsOnly: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = argv[index + 1];
		if (arg === "--") {
			continue;
		}
		if (arg === "--batch-size" && next) {
			options.batchSize = Math.max(1, Number(next) || DEFAULT_BATCH_SIZE);
			index += 1;
			continue;
		}
		if (arg === "--app-db" && next) {
			options.appDbPath = path.resolve(next);
			index += 1;
			continue;
		}
		if (arg === "--db" && next) {
			options.dbPath = path.resolve(next);
			index += 1;
			continue;
		}
		if (arg === "--force") {
			options.force = true;
			continue;
		}
		if (arg === "--limit" && next) {
			options.limit = Math.max(1, Number(next) || 1);
			index += 1;
			continue;
		}
		if (arg === "--missing-only") {
			options.missingOnly = true;
			continue;
		}
		if (arg === "--schema-only") {
			options.schemaOnly = true;
			continue;
		}
		if (arg === "--stockanalysis-ps-only") {
			options.stockAnalysisPsOnly = true;
			continue;
		}
		if (arg === "--mode" && next) {
			if (!["auto", "live", "cache"].includes(next)) {
				throw new Error(`Invalid --mode: ${next}`);
			}
			options.mode = next as StatsResolutionMode;
			index += 1;
			continue;
		}
		if (arg === "--tickers" && next) {
			options.tickers = next
				.split(",")
				.map((ticker) => normalizeTicker(ticker))
				.filter(Boolean);
			index += 1;
			continue;
		}
		if (arg === "--url" && next) {
			options.listUrl = next;
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function decodeHtml(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

function parseStockAnalysisTickers(html: string): string[] {
	const tickers: string[] = [];
	const seen = new Set<string>();
	const linkPattern =
		/<a\b[^>]*href="\/stocks\/([^"/]+)\/"[^>]*>([^<]+)<\/a>/gi;
	const citationPattern = /\d+【\d+†([A-Z][A-Z0-9.-]{0,8})】/g;
	const rowPattern = /^\s*\d+[\s.)]+([A-Z][A-Z0-9.-]{0,8})\s+/gm;

	for (const match of html.matchAll(linkPattern)) {
		const pathTicker = decodeHtml(match[1] ?? "");
		const labelTicker = decodeHtml(match[2] ?? "");
		const ticker = normalizeTicker(labelTicker || pathTicker);
		if (!ticker || seen.has(ticker)) {
			continue;
		}
		seen.add(ticker);
		tickers.push(ticker);
	}

	for (const pattern of [citationPattern, rowPattern]) {
		for (const match of html.matchAll(pattern)) {
			const ticker = normalizeTicker(decodeHtml(match[1] ?? ""));
			if (!ticker || seen.has(ticker)) {
				continue;
			}
			seen.add(ticker);
			tickers.push(ticker);
		}
	}

	return tickers;
}

function parseCsvTickers(csv: string): string[] {
	const lines = csv.split(/\r?\n/).filter(Boolean);
	const header =
		lines
			.shift()
			?.split(",")
			.map((value) => value.trim()) ?? [];
	const symbolIndex = header.findIndex((value) =>
		["symbol", "ticker"].includes(value.toLowerCase()),
	);
	if (symbolIndex < 0) {
		return [];
	}

	const tickers: string[] = [];
	const seen = new Set<string>();
	for (const line of lines) {
		const cells = line.split(",");
		const ticker = normalizeTicker(cells[symbolIndex] ?? "");
		if (!ticker || seen.has(ticker)) {
			continue;
		}
		seen.add(ticker);
		tickers.push(ticker);
	}
	return tickers;
}

async function fetchTickerListDirect(url: string): Promise<TickerList> {
	const response = await fetch(url, {
		headers: {
			accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"accept-language": "en-US,en;q=0.9",
			"user-agent": "Mozilla/5.0 (compatible; stock-search-calibration/1.0)",
		},
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status}`);
	}

	const html = await response.text();
	const tickers = parseStockAnalysisTickers(html);
	if (tickers.length === 0) {
		throw new Error(`No tickers found in ${url}`);
	}
	return { sourceKind: "stockanalysis-direct", sourceUrl: url, tickers };
}

async function fetchTickerListCsv(url: string): Promise<TickerList> {
	const response = await fetch(url, {
		headers: {
			accept: "text/csv,*/*;q=0.8",
			"user-agent": "Mozilla/5.0 (compatible; stock-search-calibration/1.0)",
		},
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status}`);
	}
	const tickers = parseCsvTickers(await response.text());
	if (tickers.length === 0) {
		throw new Error(`No tickers found in ${url}`);
	}
	return { sourceKind: "csv-fallback", sourceUrl: url, tickers };
}

async function fetchTickerListViaExa(url: string): Promise<TickerList> {
	const agent = new ExaLoadAgent({
		contentOptions: {
			maxCharacters: 80_000,
			maxAgeHours: 0,
			filterEmptyResults: false,
		},
	});
	const { pages } = await agent.load(url);
	const tickers = parseStockAnalysisTickers(pages[0]?.text ?? "");
	if (tickers.length === 0) {
		throw new Error(`No tickers found in Exa contents for ${url}`);
	}
	return { sourceKind: "stockanalysis-exa", sourceUrl: url, tickers };
}

async function fetchTickerList(url: string): Promise<TickerList> {
	try {
		return await fetchTickerListDirect(url);
	} catch (error) {
		console.warn(
			`Direct ticker-list fetch failed; falling back to Exa Contents: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	try {
		return await fetchTickerListViaExa(url);
	} catch (error) {
		console.warn(
			`Exa ticker-list fetch failed; falling back to CSV constituents: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return fetchTickerListCsv(FALLBACK_LIST_URL);
	}
}

function chunks<T>(items: T[], size: number): T[][] {
	const output: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		output.push(items.slice(index, index + size));
	}
	return output;
}

function countFields(
	rows: Array<Record<string, unknown>>,
): Record<string, number> {
	const counts = Object.fromEntries(
		SCORE_FIELD_NAMES.map((fieldName) => [fieldName, 0]),
	) as Record<string, number>;
	for (const row of rows) {
		for (const fieldName of SCORE_FIELD_NAMES) {
			if (row[fieldName] != null) {
				counts[fieldName] += 1;
			}
		}
	}
	return counts;
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function calibrationStatsSummary(dbPath: string): Promise<{
	rowCount: number;
	completeCount: number;
	incompleteCount: number;
	fieldCounts: Record<string, number>;
}> {
	const database = new DatabaseSync(dbPath);
	ensureCalibrationStatsTable(database);
	const store = new SQLiteStore(dbPath);

	const stocks = await store.loadStocks();
	const fieldCounts = Object.fromEntries(
		SCORE_FIELD_NAMES.map((fieldName) => [fieldName, 0]),
	) as Record<string, number>;
	let completeCount = 0;

	database.exec("BEGIN");
	try {
		for (const [ticker, stock] of Object.entries(stocks)) {
			const indicators = stock.indicators;
			for (const fieldName of SCORE_FIELD_NAMES) {
				if (indicators[fieldName] != null) {
					fieldCounts[fieldName] += 1;
				}
			}
			const isComplete = isCompleteCalibrationScoreRow(indicators);
			if (isComplete) {
				completeCount += 1;
			}
			upsertCalibrationStatsRow(database, ticker, indicators);
		}
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
	database.close();

	return {
		rowCount: Object.keys(stocks).length,
		completeCount,
		incompleteCount: Object.keys(stocks).length - completeCount,
		fieldCounts,
	};
}

async function loadCalibrationRowState(
	dbPath: string,
	tickers: string[],
): Promise<Map<string, { exists: boolean; isComplete: boolean }>> {
	const database = new DatabaseSync(dbPath);
	ensureCalibrationStatsTable(database);
	const store = new SQLiteStore(dbPath);
	const normalizedTickers = [
		...new Set(tickers.map(normalizeTicker).filter(Boolean)),
	];
	const rowState = new Map<string, { exists: boolean; isComplete: boolean }>();
	if (normalizedTickers.length === 0) {
		database.close();
		return rowState;
	}

	const placeholders = normalizedTickers.map(() => "?").join(", ");
	const statsRows = database
		.prepare(
			`
			SELECT ticker, is_complete
			FROM calibration_stats
			WHERE ticker IN (${placeholders})
			`,
		)
		.all(...normalizedTickers) as Array<{
		ticker: string;
		is_complete: number | null;
	}>;
	const statsByTicker = Object.fromEntries(
		statsRows.map((row) => [normalizeTicker(row.ticker), row.is_complete]),
	);
	const stocks = await store.loadStocksByTickers(normalizedTickers);
	for (const [ticker, stock] of Object.entries(stocks)) {
		const completeFlag = statsByTicker[ticker];
		rowState.set(ticker, {
			exists: true,
			isComplete:
				completeFlag == null
					? isCompleteCalibrationScoreRow(stock.indicators)
					: Number(completeFlag) === 1,
		});
	}
	database.close();
	return rowState;
}

async function syncNewerAppRows(
	options: ScriptOptions,
	tickers: string[],
): Promise<number> {
	const normalizedTickers = [
		...new Set(tickers.map(normalizeTicker).filter(Boolean)),
	];
	if (normalizedTickers.length === 0) {
		return 0;
	}

	const [calibrationStore, appStore] = [
		new SQLiteStore(options.dbPath),
		new SQLiteStore(options.appDbPath),
	];
	const [calibrationStocks, appStocks] = await Promise.all([
		calibrationStore.loadStocksByTickers(normalizedTickers),
		appStore.loadStocksByTickers(normalizedTickers),
	]);
	const upserts: CalibrationStockRow[] = [];
	for (const ticker of normalizedTickers) {
		const appStock = appStocks[ticker];
		if (!appStock) {
			continue;
		}
		const calibrationStock = calibrationStocks[ticker];
		if (
			!indicatorsAreNewer(appStock.indicators, calibrationStock?.indicators)
		) {
			continue;
		}
		upserts.push({
			ticker,
			indicators: mergeNonNullFields(
				calibrationStock?.indicators ?? {},
				appStock.indicators,
			),
			evaluation:
				Object.keys(calibrationStock?.evaluation ?? {}).length > 0
					? (calibrationStock?.evaluation ?? {})
					: appStock.evaluation,
			labels:
				(calibrationStock?.labels.length ?? 0) > 0
					? (calibrationStock?.labels ?? [])
					: appStock.labels,
		});
	}
	if (upserts.length === 0) {
		return 0;
	}

	return syncEvaluationCalibrationRows(upserts, {
		dbPath: options.dbPath,
		insertMissingRows: true,
	});
}

async function selectFetchTickers(
	options: ScriptOptions,
	candidateTickers: string[],
): Promise<{
	selectedTickers: string[];
	skippedCompleteCount: number;
}> {
	if (options.force) {
		return {
			selectedTickers: candidateTickers,
			skippedCompleteCount: 0,
		};
	}

	const rowState = await loadCalibrationRowState(
		options.dbPath,
		candidateTickers,
	);
	const selectedTickers = candidateTickers.filter((ticker) => {
		const state = rowState.get(ticker);
		if (!state?.exists) {
			return true;
		}
		return options.missingOnly && !state.isComplete;
	});
	return {
		selectedTickers,
		skippedCompleteCount: candidateTickers.length - selectedTickers.length,
	};
}

async function backfillStockAnalysisPs(options: ScriptOptions): Promise<void> {
	const store = new SQLiteStore(options.dbPath);
	const initialStocks = await store.loadStocks();
	const existingTickers = Object.keys(initialStocks).sort();
	const requestedTickers =
		options.tickers.length > 0 ? options.tickers : existingTickers;
	const candidateTickers =
		options.limit == null
			? requestedTickers
			: requestedTickers.slice(0, options.limit);
	const newerAppStockCount = await syncNewerAppRows(options, candidateTickers);
	const existingStocks = await store.loadStocks();
	const { selectedTickers, skippedCompleteCount } = options.force
		? {
				selectedTickers: candidateTickers,
				skippedCompleteCount: 0,
			}
		: {
				selectedTickers: candidateTickers.filter(
					(ticker) =>
						existingStocks[ticker]?.indicators.ps == null ||
						existingStocks[ticker]?.indicators.ps_forward == null,
				),
				skippedCompleteCount: candidateTickers.filter(
					(ticker) =>
						existingStocks[ticker]?.indicators.ps != null &&
						existingStocks[ticker]?.indicators.ps_forward != null,
				).length,
			};

	let completed = 0;
	let updated = 0;
	let missing = 0;
	const updatedRows: CalibrationStockRow[] = [];
	for (const batch of chunks(selectedTickers, options.batchSize)) {
		await Promise.all(
			batch.map(async (ticker) => {
				const existing = existingStocks[ticker] ?? {
					indicators: {},
					evaluation: {},
					labels: [],
				};
				const statistics = await new StockAnalysisSource(
					ticker,
				).getStatisticsSnapshot();
				const ps = asNumber(statistics.ps);
				const psForward = asNumber(statistics.ps_forward);
				completed += 1;
				if (ps == null && psForward == null) {
					missing += 1;
					console.log(
						`[${completed}/${selectedTickers.length}] ${ticker} no PS`,
					);
					return;
				}
				const indicators = {
					...existing.indicators,
					ps: ps ?? existing.indicators.ps,
					ps_forward: psForward ?? existing.indicators.ps_forward,
				};
				const updatedRow = {
					ticker,
					indicators,
					evaluation: existing.evaluation,
					labels: existing.labels,
				};
				await store.upsertStocks([updatedRow]);
				updatedRows.push(updatedRow);
				updated += 1;
				console.log(
					`[${completed}/${selectedTickers.length}] ${ticker} PS ${ps ?? "-"} FPS ${psForward ?? "-"}`,
				);
			}),
		);
	}
	await syncEvaluationCalibrationRows(updatedRows, {
		dbPath: options.dbPath,
		insertMissingRows: true,
	});

	const flatTable = await calibrationStatsSummary(options.dbPath);
	console.log(
		JSON.stringify(
			{
				dbPath: options.dbPath,
				mode: "stockanalysis-ps-only",
				candidateCount: candidateTickers.length,
				selectedCount: selectedTickers.length,
				skippedCompleteCount,
				newerAppStockCount,
				updatedCount: updated,
				missingCount: missing,
				flatTable: "calibration_stats",
				...flatTable,
			},
			null,
			2,
		),
	);
}

async function fetchSelectedTickers(
	store: SQLiteStore,
	options: ScriptOptions,
	selectedTickers: string[],
): Promise<CalibrationStockRow[]> {
	let completed = 0;
	const updatedRows: CalibrationStockRow[] = [];
	for (const batch of chunks(selectedTickers, options.batchSize)) {
		await Promise.all(
			batch.map(async (ticker) => {
				await resolveTickerStats(store, ticker, options.mode, null);
				const stock = await store.loadStock(ticker);
				if (stock) {
					updatedRows.push({
						ticker,
						indicators: stock.indicators,
						evaluation: stock.evaluation,
						labels: stock.labels,
					});
				}
				completed += 1;
				console.log(`[${completed}/${selectedTickers.length}] ${ticker}`);
			}),
		);
	}
	return updatedRows;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.stockAnalysisPsOnly) {
		await backfillStockAnalysisPs(options);
		return;
	}

	if (options.schemaOnly) {
		const flatTable = await calibrationStatsSummary(options.dbPath);
		console.log(
			JSON.stringify(
				{
					dbPath: options.dbPath,
					mode: "schema-only",
					flatTable: "calibration_stats",
					...flatTable,
				},
				null,
				2,
			),
		);
		return;
	}

	const store = new SQLiteStore(options.dbPath);
	const tickerList =
		options.tickers.length > 0
			? {
					sourceKind: "manual" as const,
					sourceUrl: "manual --tickers",
					tickers: options.tickers,
				}
			: await fetchTickerList(options.listUrl);
	const tickers = tickerList.tickers;
	const candidateTickers =
		options.limit == null ? tickers : tickers.slice(0, options.limit);
	const newerAppStockCount = await syncNewerAppRows(options, candidateTickers);
	const { selectedTickers, skippedCompleteCount } = await selectFetchTickers(
		options,
		candidateTickers,
	);

	await store.setMetaValue("calibration_source_url", tickerList.sourceUrl);
	await store.setMetaValue("calibration_source_kind", tickerList.sourceKind);
	await store.setMetaValue("calibration_requested_url", options.listUrl);
	await store.setMetaValue(
		"calibration_source_ticker_count",
		String(tickers.length),
	);
	await store.setMetaValue(
		"calibration_selected_ticker_count",
		String(selectedTickers.length),
	);
	await store.setMetaValue(
		"calibration_candidate_ticker_count",
		String(candidateTickers.length),
	);
	await store.setMetaValue(
		"calibration_skipped_complete_count",
		String(skippedCompleteCount),
	);
	await store.setMetaValue(
		"calibration_newer_app_stock_count",
		String(newerAppStockCount),
	);
	await store.setMetaValue(
		"calibration_filter",
		options.force ? "force" : options.missingOnly ? "missing-only" : "row-safe",
	);
	await store.setMetaValue("calibration_updated_at", nowIso());

	const updatedRows = await fetchSelectedTickers(
		store,
		options,
		selectedTickers,
	);
	await syncEvaluationCalibrationRows(updatedRows, {
		dbPath: options.dbPath,
		insertMissingRows: true,
	});

	const stocks = await store.loadStocksByTickers(selectedTickers);
	const rows = Object.values(stocks).map((stock) => stock.indicators);
	const counts = countFields(rows);
	const flatTable = await calibrationStatsSummary(options.dbPath);

	console.log(
		JSON.stringify(
			{
				dbPath: options.dbPath,
				mode: options.mode,
				sourceKind: tickerList.sourceKind,
				sourceUrl: tickerList.sourceUrl,
				sourceTickerCount: tickers.length,
				candidateTickerCount: candidateTickers.length,
				selectedTickerCount: selectedTickers.length,
				skippedCompleteCount,
				newerAppStockCount,
				storedTickerCount: Object.keys(stocks).length,
				fieldCounts: counts,
				flatTable: {
					name: "calibration_stats",
					...flatTable,
				},
			},
			null,
			2,
		),
	);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
