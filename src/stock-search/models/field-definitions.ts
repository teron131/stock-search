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
		fields: ["market_cap", "pe", "pe_forward", "peg", "beta"],
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
		fields: ["revenue_growth", "gross_margin", "operating_margin", "roic"],
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
		group.fields.map((name) => ({ name, category: group.category })),
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
	probabilities: ["bull_probability", "bear_probability", "flat_probability"],
} as const satisfies Record<string, readonly string[]>;

export const EVAL_FIELD_DEFINITIONS: readonly EvalFieldDefinition[] =
	Object.values(EVAL_FIELD_GROUPS)
		.flat()
		.map((key) => ({ key }));
