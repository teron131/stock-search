/** Define field metadata used by the dashboard and API. */

export type FieldCategory =
	| "market"
	| "fundamental"
	| "technical"
	| "evaluation";

export type FieldDefinition = {
	name: string;
	category: FieldCategory;
	label: string;
	shortLabel: string;
	description: string;
	aliases?: readonly string[];
};

export type EvalFieldDefinition = {
	key: string;
	label: string;
	shortLabel: string;
	description: string;
	aliases?: readonly string[];
};

export type FieldMetadata = {
	label: string;
	shortLabel: string;
	description: string;
};

export const FIELD_METADATA: Record<string, FieldMetadata> = {
	beta: {
		label: "Beta (5Y)",
		shortLabel: "BETA",
		description:
			"Five-year volatility vs the market. Above 1 is more volatile; below 1 is more defensive.",
	},
	change: {
		label: "Price Change",
		shortLabel: "CHG",
		description:
			"Price - previous close. Same currency units as the quoted share price.",
	},
	change_percent_1d: {
		label: "1D Change",
		shortLabel: "CHG%",
		description: "Price change from previous close. Positive is up on the day.",
	},
	change_percent_1m: {
		label: "1M Change",
		shortLabel: "1M%",
		description: "Price change over the last month.",
	},
	change_percent_3m: {
		label: "3M Change",
		shortLabel: "3M%",
		description: "Price change over the last three months.",
	},
	change_percent_6m: {
		label: "6M Change",
		shortLabel: "6M%",
		description: "Price change over the last six months.",
	},
	change_percent_1y: {
		label: "1Y Change",
		shortLabel: "1Y%",
		description: "Price change over the last year.",
	},
	debt_to_equity: {
		label: "Debt / Equity",
		shortLabel: "D/E%",
		description: "Debt divided by shareholder equity. Shown as a percentage.",
	},
	free_cash_flow: {
		label: "Free Cash Flow",
		shortLabel: "FCF",
		description:
			"Operating cash flow - capital expenditures. Cash left after maintaining the business.",
	},
	fcf_cagr_3y: {
		label: "FCF CAGR (3Y)",
		shortLabel: "FCF%3Y",
		description: "Three-year compound annual growth in free cash flow.",
	},
	fcf_growth_1y: {
		label: "FCF Growth (1Y)",
		shortLabel: "FCF%1Y",
		description:
			"Latest fiscal-year free cash flow growth versus the prior fiscal year.",
	},
	fcf_margin_median_3y: {
		label: "FCF Margin Median (3Y)",
		shortLabel: "FCFM%3Y",
		description:
			"Median free-cash-flow margin over the last three fiscal years.",
	},
	financials_currency: {
		label: "Financials Currency",
		shortLabel: "CUR",
		description:
			"Statement currency used for financial fields before normalization.",
	},
	gross_margin: {
		label: "Gross Margin",
		shortLabel: "GM%",
		description:
			"Gross profit / revenue. Higher means more revenue left after direct costs.",
	},
	gross_margin_median_3y: {
		label: "Gross Margin Median (3Y)",
		shortLabel: "GM%3Y",
		description: "Median gross margin over the last three fiscal years.",
	},
	iv: {
		label: "Implied Volatility",
		shortLabel: "IV",
		description:
			"Options-implied annualized move range. Higher means options price in larger swings.",
	},
	market_cap: {
		label: "Market Cap",
		shortLabel: "MKTC",
		description:
			"Share price * shares outstanding. Total market value of common equity.",
	},
	market_cap_score: {
		label: "Size Score",
		shortLabel: "SIZE",
		description:
			"0-10 score for scale and liquidity; 10 is best. Higher means larger and easier to trade.",
	},
	median_upside: {
		label: "Median Upside",
		shortLabel: "UP%",
		description:
			"Median analyst target upside. Positive means targets sit above spot.",
	},
	moat_score: {
		label: "Moat Score",
		shortLabel: "MOAT",
		description:
			"0-10 score for durable advantage; 10 is best. Favors pricing power, switching costs, or scale.",
	},
	notional_value: {
		label: "Notional Value",
		shortLabel: "NOTL",
		description: "Direct shares plus indirect ETF exposure tied to a ticker.",
	},
	notional_weight_pct: {
		label: "Notional Weight",
		shortLabel: "NOTL%",
		description: "Notional value as a share of portfolio value.",
	},
	operating_margin: {
		label: "Operating Margin",
		shortLabel: "OM%",
		description:
			"Operating income / revenue. Higher means stronger operating profitability.",
	},
	operating_margin_delta_vs_3y: {
		label: "Operating Margin Delta vs 3Y",
		shortLabel: "OMD%3Y",
		description:
			"Latest operating margin minus the latest-three-year median operating margin.",
	},
	operating_margin_median_3y: {
		label: "Operating Margin Median (3Y)",
		shortLabel: "OM%3Y",
		description: "Median operating margin over the last three fiscal years.",
	},
	operating_margin_std_3y: {
		label: "Operating Margin Volatility (3Y)",
		shortLabel: "OMSTD%3Y",
		description:
			"Standard deviation of operating margin over the last three fiscal years.",
	},
	overall_score: {
		label: "Overall Score",
		shortLabel: "SCORE",
		description: "0-10 composite score. Higher is better.",
	},
	pe: {
		label: "Price / Earnings (P/E)",
		shortLabel: "PE",
		description: "Price divided by trailing earnings per share.",
	},
	pe_forward: {
		label: "Forward P/E",
		shortLabel: "FPE",
		description: "Price divided by forecast earnings per share.",
	},
	ps: {
		label: "Price / Sales",
		shortLabel: "PS",
		description: "Market cap divided by trailing revenue.",
	},
	ps_forward: {
		label: "Forward Price / Sales",
		shortLabel: "FPS",
		description: "Forward price-to-sales ratio.",
	},
	peg: {
		label: "P/E to Growth",
		shortLabel: "PEG",
		description: "P/E divided by expected earnings growth.",
	},
	position_source: {
		label: "Position Source",
		shortLabel: "SRC",
		description:
			"Why this ticker appears in the portfolio view: image import, dashboard watchlist, ETF proxy, or cached universe.",
	},
	price: {
		label: "Price",
		shortLabel: "PRICE",
		description: "Latest quoted share price.",
	},
	quality_score: {
		label: "Quality Score",
		shortLabel: "QUAL",
		description:
			"0-10 score for business quality; 10 is best. Favors margins, returns, and resilience.",
	},
	quantity: {
		label: "Quantity",
		shortLabel: "QTY",
		description: "Shares held. Direct value = price * quantity.",
	},
	revenue: {
		label: "Revenue",
		shortLabel: "REV",
		description:
			"Trailing revenue. Absolute business scale before margins and capital intensity.",
	},
	rank: {
		label: "Rank",
		shortLabel: "RANK",
		description:
			"Evaluation order. Rank 1 is highest priority; larger numbers are lower priority.",
	},
	revenue_growth: {
		label: "Revenue Growth",
		shortLabel: "REV%",
		description:
			"(Revenue / prior revenue - 1). Shows top-line growth before margins.",
	},
	revenue_cagr_3y: {
		label: "Revenue CAGR (3Y)",
		shortLabel: "REV%3Y",
		description: "Three-year compound annual revenue growth.",
	},
	revenue_growth_1y: {
		label: "Revenue Growth (1Y)",
		shortLabel: "REV%1Y",
		description:
			"Latest fiscal-year revenue growth versus the prior fiscal year.",
	},
	eps_growth: {
		label: "EPS Growth",
		shortLabel: "EPS%",
		description:
			"Per-share earnings growth after margins, interest, tax, and dilution.",
	},
	rd_intensity: {
		label: "R&D Intensity",
		shortLabel: "R&D%",
		description:
			"Latest fiscal-year R&D expense / revenue. Used as currency-safe R&D evidence.",
	},
	rd_knowledge_capital: {
		label: "R&D Knowledge Capital",
		shortLabel: "R&D3Y",
		description: "Weighted recent R&D spend used as a knowledge-capital proxy.",
	},
	research_and_development: {
		label: "Research & Development",
		shortLabel: "R&D",
		description: "Latest fiscal-year R&D expense.",
	},
	roe: {
		label: "Return on Equity",
		shortLabel: "ROE",
		description:
			"Net income / shareholder equity. Higher can signal strong owner returns, but leverage and buybacks can distort it.",
	},
	roic: {
		label: "Return on Invested Capital",
		shortLabel: "ROIC",
		description:
			"After-tax operating profit / invested capital. Above capital cost creates value.",
	},
	rsi: {
		label: "Relative Strength Index (14D)",
		shortLabel: "RSI",
		description:
			"0-100 momentum oscillator. >70 often overbought; <30 often oversold.",
	},
	shareholder_yield: {
		label: "Shareholder Yield",
		shortLabel: "YLD%",
		description: "Dividend yield plus net buyback yield.",
	},
	shares_change_1y: {
		label: "Shares Change (1Y)",
		shortLabel: "SH%1Y",
		description:
			"Latest fiscal-year year-over-year change in shares outstanding.",
	},
	shares_change_cagr_3y: {
		label: "Shares Change CAGR (3Y)",
		shortLabel: "SH%3Y",
		description: "Three-year compound annual change in shares outstanding.",
	},
	strategy: {
		label: "Strategy",
		shortLabel: "STRAT",
		description:
			"Holding stance such as Core, Satellite, or Speculation. Guides portfolio treatment.",
	},
	ticker: {
		label: "Ticker",
		shortLabel: "TICKER",
		description:
			"Exchange ticker symbol. Primary key for quotes, stats, and news lookup.",
	},
	tactical_score: {
		label: "Tactical Score",
		shortLabel: "TACT",
		description:
			"0-10 short-to-medium-term setup score. Does not feed Overall.",
	},
	total: {
		label: "Position Value",
		shortLabel: "VALUE",
		description: "Price * quantity. Direct market value of the held shares.",
	},
	upside_score: {
		label: "Upside Score",
		shortLabel: "UP",
		description:
			"0-10 forward return setup score. Higher means stronger upside support.",
	},
	valuation_score: {
		label: "Valuation Score",
		shortLabel: "VAL",
		description:
			"0-10 valuation score. Higher means cheaper or better-supported value.",
	},
	weight_pct: {
		label: "Weight",
		shortLabel: "WGT%",
		description:
			"Direct value / portfolio value. Shows concentration from direct holdings.",
	},
};

export function getFieldMetadata(key: string): FieldMetadata {
	return (
		FIELD_METADATA[key] ?? {
			label: key,
			shortLabel: key,
			description: key,
		}
	);
}

export function getFieldDescription(key: string): string {
	return getFieldMetadata(key).description;
}

type IndicatorFieldGroup = {
	category: FieldCategory;
	fields: readonly string[];
};

export const INDICATOR_FIELD_GROUPS = {
	marketData: {
		category: "market",
		fields: ["price", "change_percent_1d", "change"],
	},
	valuation: {
		category: "fundamental",
		fields: [
			"market_cap",
			"pe",
			"pe_forward",
			"ps",
			"ps_forward",
			"peg",
			"beta",
		],
	},
	technicalSnapshot: {
		category: "technical",
		fields: ["iv", "rsi"],
	},
	momentum: {
		category: "market",
		fields: [
			"change_percent_1m",
			"change_percent_3m",
			"change_percent_6m",
			"change_percent_1y",
		],
	},
	analyst: {
		category: "evaluation",
		fields: ["median_upside"],
	},
	operatingQuality: {
		category: "fundamental",
		fields: [
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
			"roe",
			"roic",
		],
	},
	capitalReturns: {
		category: "fundamental",
		fields: [
			"debt_to_equity",
			"free_cash_flow",
			"fcf_margin_median_3y",
			"shares_change_1y",
			"shares_change_cagr_3y",
			"shareholder_yield",
			"research_and_development",
			"rd_intensity",
			"rd_knowledge_capital",
		],
	},
} as const satisfies Record<string, IndicatorFieldGroup>;

function fieldDefinitionsFromGroups(
	groups: Record<string, IndicatorFieldGroup>,
): FieldDefinition[] {
	return Object.values(groups).flatMap((group) =>
		group.fields.map((name) => ({
			name,
			category: group.category,
			...getFieldMetadata(name),
		})),
	);
}

export const INDICATOR_FIELD_DEFINITIONS: readonly FieldDefinition[] =
	fieldDefinitionsFromGroups(INDICATOR_FIELD_GROUPS);

export const INDICATOR_FIELDS = INDICATOR_FIELD_DEFINITIONS.map(
	(field) => field.name,
);

export const MARKET_FIELDS = new Set<string>(INDICATOR_FIELDS);

export const EVAL_FIELD_GROUPS = {
	scores: [
		"overall_score",
		"quality_score",
		"valuation_score",
		"moat_score",
		"upside_score",
		"market_cap_score",
		"tactical_score",
	],
} as const satisfies Record<string, readonly string[]>;

export const EVAL_FIELD_DEFINITIONS: readonly EvalFieldDefinition[] =
	Object.values(EVAL_FIELD_GROUPS)
		.flat()
		.map((key) => ({ key, ...getFieldMetadata(key) }));
