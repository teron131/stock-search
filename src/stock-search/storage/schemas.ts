/** Define the shared SQLite/D1 table shape, column lists, and schema SQL. */

export type StorageValue = string | number | null;
export type ColumnKind = "real" | "text";
export type StockScalarColumn = {
	name: string;
	kind: ColumnKind;
	group: "indicator" | "evaluation";
};

function fieldNames(value: string): string[] {
	return value.trim().split(/\s+/).filter(Boolean);
}

function sqlLines(value: string): string[] {
	return value
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

export const DEFAULT_STORAGE_KEY = "default";

export const PORTFOLIO_STAT_COLUMNS = fieldNames(`
	total change change_percent held_positions_count weighted_beta weighted_iv
`);

export const NEWS_FIELD_COLUMNS = fieldNames(`
	url title date summary relevancy category sentiment
`);
export const NEWS_METADATA_COLUMNS = fieldNames(`
	provider source_domain published_at fetched_at
`);
export const NEWS_KNOWN_FIELDS = new Set([
	...NEWS_FIELD_COLUMNS,
	"days_ago",
	"metadata",
]);
export const NEWS_KNOWN_METADATA_FIELDS = new Set(NEWS_METADATA_COLUMNS);

export const STOCK_TEXT_INDICATOR_COLUMNS = fieldNames(`
	name strategy quote_type equity_type fx sector_name industry_name
	earning_direction market_data_fetched_at market_snapshot_fetched_at
	statistics_fetched_at financials_fetched_at ratings_fetched_at
	industry_labels_fetched_at etf_holdings_fetched_at peg_source
`);

export const STOCK_NUMERIC_INDICATOR_COLUMNS = fieldNames(`
	price change change_percent_1d change_percent_1m change_percent_3m
	change_percent_6m change_percent_1y change_percent_mtd change_percent_ytd
	fifty_day_change_percent one_hundred_day_change_percent two_hundred_day_change_percent
	market_cap pe pe_forward ps ps_forward peg beta iv rsi median_upside
	revenue revenue_growth revenue_growth_1y revenue_cagr_3y eps_growth
	eps_this_y_growth eps_next_y_growth eps_next_5y_growth eps_past_3y_growth
	eps_past_5y_growth sales_past_3y_growth sales_past_5y_growth eps_yoy_ttm_growth
	fcf_growth_1y fcf_cagr_3y gross_margin gross_margin_median_3y
	operating_margin operating_margin_median_3y operating_margin_delta_vs_3y
	operating_margin_std_3y roe roic debt_to_equity free_cash_flow
	fcf_margin_median_3y shares_change_1y shares_change_cagr_3y shareholder_yield
	research_and_development rd_intensity rd_knowledge_capital
`);

export const STOCK_NUMERIC_EVALUATION_COLUMNS = fieldNames(`
	overall_score quality_score valuation_score moat_score upside_score
	market_cap_score tactical_score
`);

export const CALIBRATION_SCORE_FIELD_NAMES = fieldNames(`
	market_cap peg pe pe_forward ps ps_forward debt_to_equity free_cash_flow
	shareholder_yield rd_knowledge_capital rd_intensity revenue revenue_growth
	eps_growth gross_margin operating_margin roe roic median_upside
`);

export const CALIBRATION_FETCHED_AT_FIELDS = fieldNames(`
	market_data_fetched_at market_snapshot_fetched_at statistics_fetched_at
	financials_fetched_at ratings_fetched_at
`);

export const CALIBRATION_STATS_COLUMN_DEFINITIONS = sqlLines(`
	ticker TEXT PRIMARY KEY
	name TEXT
	sector_name TEXT
	industry_name TEXT
	quote_type TEXT
	fx TEXT
	price REAL
	change REAL
	change_percent_1d REAL
	market_cap REAL
	peg REAL
	pe REAL
	pe_forward REAL
	ps REAL
	ps_forward REAL
	debt_to_equity REAL
	free_cash_flow REAL
	shareholder_yield REAL
	rd_knowledge_capital REAL
	rd_intensity REAL
	revenue REAL
	revenue_growth REAL
	eps_growth REAL
	gross_margin REAL
	operating_margin REAL
	roe REAL
	roic REAL
	median_upside REAL
	is_complete INTEGER NOT NULL DEFAULT 0
	missing_score_fields TEXT NOT NULL DEFAULT ''
	missing_score_field_count INTEGER NOT NULL DEFAULT 0
	market_data_fetched_at TEXT
	market_snapshot_fetched_at TEXT
	statistics_fetched_at TEXT
	financials_fetched_at TEXT
	ratings_fetched_at TEXT
	last_fetched_at TEXT
`);

export const CALIBRATION_STATS_COLUMN_NAMES =
	CALIBRATION_STATS_COLUMN_DEFINITIONS.map(
		(definition) => definition.split(/\s+/, 1)[0] ?? "",
	).filter(Boolean);

export type CalibrationStatsRow = Record<string, StorageValue> & {
	ticker: string;
};

export const STOCK_EVALUATION_REASON_COLUMNS = [
	["moat_score", "moat_reasons"],
	["quality_score", "quality_reasons"],
	["upside_score", "upside_reasons"],
] as const;

export const STOCK_FUTURE_OUTLOOK_COLUMNS = {
	score: "future_score",
	reasons: "future_reasons",
} as const;

export const STOCK_SERIALIZED_INDICATOR_COLUMNS = fieldNames(`
	industry_labels ratings etf_holdings etf_sectors
`);

export const STOCK_SCALAR_COLUMNS: readonly StockScalarColumn[] = [
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

export const STOCK_COLUMN_NAMES = [
	"labels",
	"indicator_extra",
	"evaluation_extra",
	...STOCK_SCALAR_COLUMNS.map((column) => column.name),
	STOCK_FUTURE_OUTLOOK_COLUMNS.score,
	STOCK_FUTURE_OUTLOOK_COLUMNS.reasons,
	...STOCK_EVALUATION_REASON_COLUMNS.map(([, reasonsColumn]) => reasonsColumn),
	...STOCK_SERIALIZED_INDICATOR_COLUMNS,
];
export const STOCK_SELECT_COLUMNS = ["ticker", ...STOCK_COLUMN_NAMES].join(
	", ",
);
export const POSITION_COLUMN_NAMES = new Set(
	fieldNames("ticker quantity strategy industry_labels"),
);

export function tableSchemaQueries(): string[] {
	return [...TABLE_DEFINITIONS.map(tableCreateQuery), ...INDEX_QUERIES];
}

function columnSqlType(kind: ColumnKind): string {
	return kind === "real" ? "REAL" : "TEXT";
}

function stockColumnDefinitions(): string[] {
	return [
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
		"updated_at INTEGER NOT NULL",
	];
}

type TableDefinition = {
	name: string;
	columns: string[];
	primaryKey?: string;
};

const TABLE_DEFINITIONS: TableDefinition[] = [
	{
		name: "portfolio_stats",
		columns: sqlLines(`
			key TEXT PRIMARY KEY
			total REAL
			change REAL
			change_percent REAL
			held_positions_count REAL
			weighted_beta REAL
			weighted_iv REAL
			extra TEXT NOT NULL DEFAULT '{}'
			updated_at INTEGER NOT NULL
		`),
	},
	{
		name: "positions",
		columns: sqlLines(`
			key TEXT NOT NULL
			ticker TEXT NOT NULL
			sort_index INTEGER NOT NULL
			quantity REAL
			strategy TEXT
			industry_labels TEXT NOT NULL DEFAULT '[]'
			extra TEXT NOT NULL DEFAULT '{}'
		`),
		primaryKey: "key, ticker",
	},
	{
		name: "stocks",
		columns: stockColumnDefinitions(),
	},
	{
		name: "calibration_stats",
		columns: CALIBRATION_STATS_COLUMN_DEFINITIONS,
	},
	{
		name: "news",
		columns: sqlLines(`
			key TEXT NOT NULL
			ticker TEXT NOT NULL
			url TEXT
			title TEXT
			date TEXT
			summary TEXT
			relevancy TEXT
			category TEXT
			sentiment TEXT
			days_ago REAL
			metadata_provider TEXT
			metadata_source_domain TEXT
			metadata_published_at TEXT
			metadata_fetched_at TEXT
			row_json TEXT NOT NULL DEFAULT '{}'
			updated_at INTEGER NOT NULL
		`),
		primaryKey: "key, ticker",
	},
	{
		name: "sector_snapshots",
		columns: sqlLines(`
			key TEXT PRIMARY KEY
			source TEXT
			fetched_at TEXT
			sector_count REAL
			extra TEXT NOT NULL DEFAULT '{}'
			updated_at INTEGER NOT NULL
		`),
	},
	{
		name: "sector_snapshot_sectors",
		columns: sqlLines(`
			key TEXT NOT NULL
			sector TEXT NOT NULL
			sort_index INTEGER NOT NULL
			top_ticker_1 TEXT
			top_ticker_2 TEXT
			top_ticker_3 TEXT
			top_ticker_4 TEXT
			top_ticker_5 TEXT
			stock_count REAL
			market_cap REAL
			pe REAL
			profit_margin REAL
			change_percent_1d REAL
			change_percent_1y REAL
			extra TEXT NOT NULL DEFAULT '{}'
		`),
		primaryKey: "key, sector",
	},
	{
		name: "meta",
		columns: sqlLines(`
			key TEXT PRIMARY KEY
			value TEXT NOT NULL
			updated_at INTEGER NOT NULL
		`),
	},
];

const INDEX_QUERIES = [
	"CREATE INDEX IF NOT EXISTS idx_positions_key_sort ON positions (key, sort_index)",
	"CREATE INDEX IF NOT EXISTS idx_news_key ON news (key)",
	"CREATE INDEX IF NOT EXISTS idx_news_category ON news (category)",
	"CREATE INDEX IF NOT EXISTS idx_stocks_updated_at ON stocks (updated_at)",
	"CREATE INDEX IF NOT EXISTS idx_stocks_sector_name ON stocks (sector_name)",
	"CREATE INDEX IF NOT EXISTS idx_calibration_complete ON calibration_stats (is_complete, missing_score_field_count)",
	"CREATE INDEX IF NOT EXISTS idx_calibration_sector ON calibration_stats (sector_name)",
	"CREATE INDEX IF NOT EXISTS idx_sector_rows_key_sort ON sector_snapshot_sectors (key, sort_index)",
];

function tableCreateQuery({
	name,
	columns,
	primaryKey,
}: TableDefinition): string {
	const definitions = primaryKey
		? [...columns, `PRIMARY KEY (${primaryKey})`]
		: columns;
	return `CREATE TABLE IF NOT EXISTS ${name} (${definitions.join(", ")})`;
}
