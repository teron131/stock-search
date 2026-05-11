import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ExaLoadAgent } from "llm-harness-js/agents";

import { fetchStockAnalysisStatistics } from "../src/stock-search/indicators.js";
import { SQLiteStore } from "../src/stock-search/sqlite-store.js";
import {
	resolveTickerStats,
	type StatsResolutionMode,
} from "../src/stock-search/stats-resolver.js";
import { normalizeTicker, nowIso } from "../src/stock-search/utils.js";

const DEFAULT_LIST_URL = "https://stockanalysis.com/list/sp-500-stocks/";
const FALLBACK_LIST_URL =
	"https://datahub.io/core/s-and-p-500-companies/_r/-/data/constituents.csv";
const DEFAULT_DB_PATH = path.resolve("data/evaluation_calibration.db");
const DEFAULT_BATCH_SIZE = 25;
const SCORE_FIELD_NAMES = [
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
	"gross_margin",
	"operating_margin",
	"roe",
	"roic",
	"median_upside",
] as const;

type ScriptOptions = {
	batchSize: number;
	dbPath: string;
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
		batchSize: DEFAULT_BATCH_SIZE,
		dbPath: process.env.CALIBRATION_SQLITE_PATH
			? path.resolve(process.env.CALIBRATION_SQLITE_PATH)
			: DEFAULT_DB_PATH,
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
		if (arg === "--db" && next) {
			options.dbPath = path.resolve(next);
			index += 1;
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

function hasAllScoreFields(row: Record<string, unknown> | undefined): boolean {
	return (
		!!row && SCORE_FIELD_NAMES.every((fieldName) => row[fieldName] != null)
	);
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asText(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function createCalibrationStatsTable(dbPath: string): {
	rowCount: number;
	completeCount: number;
	incompleteCount: number;
	fieldCounts: Record<string, number>;
} {
	const database = new DatabaseSync(dbPath);
	database.exec(`
		DROP TABLE IF EXISTS calibration_stats;
		CREATE TABLE calibration_stats (
			ticker TEXT PRIMARY KEY,
			name TEXT,
			sector_name TEXT,
			industry_name TEXT,
			quote_type TEXT,
			fx TEXT,
			price REAL,
			change REAL,
			change_percent_1d REAL,
			market_cap REAL,
			peg REAL,
			pe REAL,
			pe_forward REAL,
			ps REAL,
			ps_forward REAL,
			debt_to_equity REAL,
			free_cash_flow REAL,
			shareholder_yield REAL,
			revenue REAL,
			revenue_growth REAL,
			gross_margin REAL,
			operating_margin REAL,
			roe REAL,
			roic REAL,
			median_upside REAL,
			is_complete INTEGER NOT NULL,
			missing_score_fields TEXT NOT NULL,
			missing_score_field_count INTEGER NOT NULL,
			market_data_fetched_at TEXT,
			market_snapshot_fetched_at TEXT,
			statistics_fetched_at TEXT,
			financials_fetched_at TEXT,
			ratings_fetched_at TEXT
		);
		CREATE INDEX calibration_stats_complete_idx
			ON calibration_stats (is_complete, missing_score_field_count);
		CREATE INDEX calibration_stats_sector_idx
			ON calibration_stats (sector_name);
	`);

	const rows = database
		.prepare(
			`
			SELECT ticker, indicators_json
			FROM stocks
			ORDER BY ticker ASC
			`,
		)
		.all() as Array<{ ticker: string; indicators_json: string }>;
	const insert = database.prepare(`
		INSERT INTO calibration_stats (
			ticker,
			name,
			sector_name,
			industry_name,
			quote_type,
			fx,
			price,
			change,
			change_percent_1d,
			market_cap,
			peg,
			pe,
			pe_forward,
			ps,
			ps_forward,
			debt_to_equity,
			free_cash_flow,
			shareholder_yield,
			revenue,
			revenue_growth,
			gross_margin,
			operating_margin,
			roe,
			roic,
			median_upside,
			is_complete,
			missing_score_fields,
			missing_score_field_count,
			market_data_fetched_at,
			market_snapshot_fetched_at,
			statistics_fetched_at,
			financials_fetched_at,
			ratings_fetched_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const fieldCounts = Object.fromEntries(
		SCORE_FIELD_NAMES.map((fieldName) => [fieldName, 0]),
	) as Record<string, number>;
	let completeCount = 0;

	database.exec("BEGIN");
	try {
		for (const row of rows) {
			const indicators = JSON.parse(row.indicators_json) as Record<
				string,
				unknown
			>;
			const missingScoreFields = SCORE_FIELD_NAMES.filter(
				(fieldName) => indicators[fieldName] == null,
			);
			for (const fieldName of SCORE_FIELD_NAMES) {
				if (indicators[fieldName] != null) {
					fieldCounts[fieldName] += 1;
				}
			}
			const isComplete = missingScoreFields.length === 0;
			if (isComplete) {
				completeCount += 1;
			}

			insert.run(
				row.ticker,
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
				asNumber(indicators.gross_margin),
				asNumber(indicators.operating_margin),
				asNumber(indicators.roe),
				asNumber(indicators.roic),
				asNumber(indicators.median_upside),
				isComplete ? 1 : 0,
				missingScoreFields.join(","),
				missingScoreFields.length,
				asText(indicators.market_data_fetched_at),
				asText(indicators.market_snapshot_fetched_at),
				asText(indicators.statistics_fetched_at),
				asText(indicators.financials_fetched_at),
				asText(indicators.ratings_fetched_at),
			);
		}
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
	database.close();

	return {
		rowCount: rows.length,
		completeCount,
		incompleteCount: rows.length - completeCount,
		fieldCounts,
	};
}

function dropCalibrationAuxiliaryTables(dbPath: string): void {
	const database = new DatabaseSync(dbPath);
	database.exec(`
		DROP TABLE IF EXISTS meta;
		DROP TABLE IF EXISTS news;
		DROP TABLE IF EXISTS positions;
	`);
	database.close();
}

async function backfillStockAnalysisPs(options: ScriptOptions): Promise<void> {
	const store = new SQLiteStore(options.dbPath);
	const existingStocks = await store.loadStocks();
	const existingTickers = Object.keys(existingStocks).sort();
	const requestedTickers =
		options.tickers.length > 0 ? options.tickers : existingTickers;
	const candidateTickers =
		options.limit == null
			? requestedTickers
			: requestedTickers.slice(0, options.limit);
	const selectedTickers = options.missingOnly
		? candidateTickers.filter(
				(ticker) =>
					existingStocks[ticker]?.indicators.ps == null ||
					existingStocks[ticker]?.indicators.ps_forward == null,
			)
		: candidateTickers;

	let completed = 0;
	let updated = 0;
	let missing = 0;
	for (const batch of chunks(selectedTickers, options.batchSize)) {
		await Promise.all(
			batch.map(async (ticker) => {
				const existing = existingStocks[ticker] ?? {
					indicators: {},
					evaluation: {},
					labels: [],
				};
				const statistics = await fetchStockAnalysisStatistics(ticker);
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
				await store.upsertStocks([
					{
						ticker,
						indicators: {
							...existing.indicators,
							ps: ps ?? existing.indicators.ps,
							ps_forward: psForward ?? existing.indicators.ps_forward,
						},
						evaluation: existing.evaluation,
						labels: existing.labels,
					},
				]);
				updated += 1;
				console.log(
					`[${completed}/${selectedTickers.length}] ${ticker} PS ${ps ?? "-"} FPS ${psForward ?? "-"}`,
				);
			}),
		);
	}

	const flatTable = createCalibrationStatsTable(options.dbPath);
	dropCalibrationAuxiliaryTables(options.dbPath);
	console.log(
		JSON.stringify(
			{
				dbPath: options.dbPath,
				mode: "stockanalysis-ps-only",
				candidateCount: candidateTickers.length,
				selectedCount: selectedTickers.length,
				skippedCompleteCount: candidateTickers.length - selectedTickers.length,
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

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.stockAnalysisPsOnly) {
		await backfillStockAnalysisPs(options);
		return;
	}

	if (options.schemaOnly) {
		const flatTable = createCalibrationStatsTable(options.dbPath);
		dropCalibrationAuxiliaryTables(options.dbPath);
		console.log(
			JSON.stringify(
				{
					dbPath: options.dbPath,
					mode: "schema-only",
					flatTable: "calibration_stats",
					removedTables: ["meta", "news", "positions"],
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
	const existingStocks = options.missingOnly
		? await store.loadStocksByTickers(candidateTickers)
		: {};
	const selectedTickers = options.missingOnly
		? candidateTickers.filter(
				(ticker) => !hasAllScoreFields(existingStocks[ticker]?.indicators),
			)
		: candidateTickers;
	const skippedCompleteCount = candidateTickers.length - selectedTickers.length;

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
		"calibration_filter",
		options.missingOnly ? "missing-only" : "all",
	);
	await store.setMetaValue("calibration_updated_at", nowIso());

	let completed = 0;
	for (const batch of chunks(selectedTickers, options.batchSize)) {
		await Promise.all(
			batch.map(async (ticker) => {
				await resolveTickerStats(store, ticker, options.mode, null);
				completed += 1;
				console.log(`[${completed}/${selectedTickers.length}] ${ticker}`);
			}),
		);
	}

	const stocks = await store.loadStocksByTickers(selectedTickers);
	const rows = Object.values(stocks).map((stock) => stock.indicators);
	const counts = countFields(rows);
	const flatTable = createCalibrationStatsTable(options.dbPath);
	dropCalibrationAuxiliaryTables(options.dbPath);

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
				storedTickerCount: Object.keys(stocks).length,
				fieldCounts: counts,
				flatTable: {
					name: "calibration_stats",
					removedTables: ["meta", "news", "positions"],
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
