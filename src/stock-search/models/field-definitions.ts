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
			"Five-year volatility vs market: 1 = market-like, >1 more volatile, <1 more defensive.",
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
		description:
			"(Price / previous close - 1). Positive is up on the day; negative is down.",
	},
	change_percent_1m: {
		label: "1M Change",
		shortLabel: "1M%",
		description: "(Price / price 1M ago - 1). Short-term momentum window.",
	},
	change_percent_3m: {
		label: "3M Change",
		shortLabel: "3M%",
		description: "(Price / price 3M ago - 1). Medium-term momentum window.",
	},
	change_percent_6m: {
		label: "6M Change",
		shortLabel: "6M%",
		description:
			"(Price / price 6M ago - 1). Helps separate trend from one-off moves.",
	},
	change_percent_1y: {
		label: "1Y Change",
		shortLabel: "1Y%",
		description:
			"(Price / price 1Y ago - 1). Longer-term market performance signal.",
	},
	change_percent_mtd: {
		label: "MTD Change",
		shortLabel: "MTD%",
		description:
			"(Price / month-start price - 1). Resets at the start of each month.",
	},
	change_percent_ytd: {
		label: "YTD Change",
		shortLabel: "YTD%",
		description:
			"(Price / year-start price - 1). Resets at the start of each year.",
	},
	debt_to_equity: {
		label: "Debt / Equity",
		shortLabel: "D/E",
		description:
			"Debt / shareholder equity. 0 is ungeared; higher means more leverage.",
	},
	free_cash_flow: {
		label: "Free Cash Flow",
		shortLabel: "FCF",
		description:
			"Operating cash flow - capital expenditures. Cash left after maintaining the business.",
	},
	gross_margin: {
		label: "Gross Margin",
		shortLabel: "GM%",
		description:
			"Gross profit / revenue. Higher means more revenue left after direct costs.",
	},
	iv: {
		label: "Implied Volatility",
		shortLabel: "IV",
		description:
			"Options-implied annualized move range. Higher means options price in larger swings.",
	},
	market_cap: {
		label: "Market Cap",
		shortLabel: "MCAP",
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
			"(Analyst target / price - 1). Positive means targets sit above spot.",
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
		description:
			"Direct shares + indirect ETF exposure. Shows the effective dollars tied to a ticker.",
	},
	notional_weight_pct: {
		label: "Notional Weight",
		shortLabel: "NOTL%",
		description:
			"Notional value / portfolio value. Includes direct shares and indirect ETF exposure.",
	},
	operating_margin: {
		label: "Operating Margin",
		shortLabel: "OM%",
		description:
			"Operating income / revenue. Higher means stronger operating profitability.",
	},
	overall_score: {
		label: "Overall Score",
		shortLabel: "SCORE",
		description:
			"0-10 composite score; 10 is best. Blends quality, value, moat, upside, and risk.",
	},
	pe: {
		label: "Price / Earnings (P/E)",
		shortLabel: "PE",
		description:
			"Price / trailing earnings per share. Lower can be cheaper; losses make it unusable.",
	},
	pe_forward: {
		label: "Forward P/E",
		shortLabel: "FPE",
		description:
			"Price / forecast earnings per share. Lower can signal cheaper expected profits.",
	},
	ps: {
		label: "Price / Sales",
		shortLabel: "P/S",
		description:
			"Market cap / trailing revenue. Lower can be cheaper; high-growth firms often sustain higher multiples.",
	},
	ps_forward: {
		label: "Forward Price / Sales",
		shortLabel: "FPS",
		description:
			"Forward P/S or Forward Price / Sales ratio. Use only when explicitly displayed.",
	},
	peg: {
		label: "P/E to Growth",
		shortLabel: "PEG",
		description:
			"P/E / expected earnings growth. Around 1 is neutral; lower is cheaper growth.",
	},
	price: {
		label: "Price",
		shortLabel: "PRICE",
		description:
			"Latest quoted share price. Drives position value and valuation multiples.",
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
	eps_growth: {
		label: "EPS Growth",
		shortLabel: "EPS%",
		description:
			"(EPS / prior EPS - 1). Shows per-share earnings growth after margins, interest, tax, and dilution.",
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
		description:
			"Dividend yield + net buyback yield. Shows shareholder cash return after dilution.",
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
	total: {
		label: "Position Value",
		shortLabel: "VALUE",
		description: "Price * quantity. Direct market value of the held shares.",
	},
	upside_score: {
		label: "Upside Score",
		shortLabel: "UP",
		description:
			"0-10 score for upside; 10 is best. Favors better reward versus current price.",
	},
	valuation_score: {
		label: "Valuation Score",
		shortLabel: "VAL",
		description:
			"0-10 valuation score; 10 is best. Favors cheaper or better-supported multiples.",
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
		fields: ["iv"],
	},
	momentum: {
		category: "market",
		fields: [
			"change_percent_1m",
			"change_percent_3m",
			"change_percent_6m",
			"change_percent_1y",
			"change_percent_mtd",
			"change_percent_ytd",
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
			"eps_growth",
			"gross_margin",
			"operating_margin",
			"roe",
			"roic",
		],
	},
	capitalReturns: {
		category: "fundamental",
		fields: ["debt_to_equity", "free_cash_flow", "shareholder_yield"],
	},
	technicalMomentum: {
		category: "technical",
		fields: ["rsi"],
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
	],
} as const satisfies Record<string, readonly string[]>;

export const EVAL_FIELD_DEFINITIONS: readonly EvalFieldDefinition[] =
	Object.values(EVAL_FIELD_GROUPS)
		.flat()
		.map((key) => ({ key, ...getFieldMetadata(key) }));
