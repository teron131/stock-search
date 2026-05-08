/** Define field metadata used by the dashboard and API. */

export type FieldCategory =
	| "market"
	| "fundamental"
	| "technical"
	| "evaluation";

export type FieldDefinition = {
	name: string;
	category: FieldCategory;
	aliases?: readonly string[];
};

export type EvalFieldDefinition = {
	key: string;
	aliases?: readonly string[];
};

export const INDICATOR_FIELD_DEFINITIONS: readonly FieldDefinition[] = [
	{ name: "price", category: "market" },
	{ name: "change_percent_1d", category: "market" },
	{ name: "change", category: "market" },
	{ name: "market_cap", category: "fundamental" },
	{ name: "pe", category: "fundamental" },
	{ name: "pe_forward", category: "fundamental" },
	{ name: "peg", category: "fundamental" },
	{ name: "beta", category: "fundamental" },
	{ name: "iv", category: "technical" },
	{ name: "change_percent_1m", category: "market" },
	{ name: "change_percent_3m", category: "market" },
	{ name: "change_percent_6m", category: "market" },
	{ name: "change_percent_1y", category: "market" },
	{ name: "change_percent_mtd", category: "market" },
	{ name: "change_percent_ytd", category: "market" },
	{ name: "median_upside", category: "evaluation" },
	{ name: "revenue_growth", category: "fundamental" },
	{ name: "gross_margin", category: "fundamental" },
	{ name: "operating_margin", category: "fundamental" },
	{ name: "roic", category: "fundamental" },
	{ name: "debt_to_equity", category: "fundamental" },
	{ name: "free_cash_flow", category: "fundamental" },
	{ name: "rsi", category: "technical" },
];

export const INDICATOR_FIELDS = INDICATOR_FIELD_DEFINITIONS.map(
	(field) => field.name,
);

export const MARKET_FIELDS = new Set<string>([
	"price",
	"change",
	"change_percent_1d",
	"market_cap",
	"pe",
	"pe_forward",
	"peg",
	"beta",
	"iv",
	"debt_to_equity",
	"free_cash_flow",
	"revenue_growth",
	"gross_margin",
	"operating_margin",
	"roic",
	"rsi",
	"change_percent_1m",
	"change_percent_3m",
	"change_percent_6m",
	"change_percent_1y",
	"change_percent_mtd",
	"change_percent_ytd",
	"median_upside",
]);

export const EVAL_FIELD_DEFINITIONS: readonly EvalFieldDefinition[] = [
	{ key: "overall_score" },
	{ key: "quality_score" },
	{ key: "valuation_score" },
	{ key: "moat_score" },
	{ key: "upside_score" },
	{ key: "bull_probability" },
	{ key: "bear_probability" },
];
