/** Load opinionated score anchors from the local calibration database. */

import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	CalibrationConfig,
	MarketCapConfig,
	type MinMedMax,
} from "./constants.js";

const POSITIVE_PERCENTILES = [0.1, 0.5, 0.97] as const;
const INVERSE_PERCENTILES = [0.03, 0.5, 0.9] as const;
const MIN_DYNAMIC_ANCHOR_SAMPLE_SIZE = 50;
const DEFAULT_CALIBRATION_DB_PATH = path.resolve(
	"data/evaluation_calibration.db",
);

export type ScoreAnchorKey =
	| "market_cap"
	| "peg"
	| "pe"
	| "pe_forward"
	| "ps"
	| "ps_forward"
	| "debt_to_equity"
	| "fcf_yield"
	| "shareholder_yield"
	| "revenue_growth"
	| "gross_margin"
	| "operating_margin"
	| "roe"
	| "roic"
	| "median_upside";

export type ScoreAnchors = Record<ScoreAnchorKey, MinMedMax>;

export const STATIC_SCORE_ANCHORS: ScoreAnchors = {
	market_cap: [
		MarketCapConfig.MIN,
		MarketCapConfig.MEDIAN,
		MarketCapConfig.MAX,
	],
	peg: CalibrationConfig.PEG_RANGE,
	pe: CalibrationConfig.PE_RANGE,
	pe_forward: CalibrationConfig.PE_FORWARD_RANGE,
	ps: CalibrationConfig.PS_RANGE,
	ps_forward: CalibrationConfig.PS_FORWARD_RANGE,
	debt_to_equity: CalibrationConfig.DEBT_TO_EQUITY_PCT_RANGE,
	fcf_yield: CalibrationConfig.FCF_YIELD_PCT_RANGE,
	shareholder_yield: CalibrationConfig.SHAREHOLDER_YIELD_PCT_RANGE,
	revenue_growth: CalibrationConfig.REVENUE_GROWTH_PCT_RANGE,
	gross_margin: CalibrationConfig.GROSS_MARGIN_PCT_RANGE,
	operating_margin: CalibrationConfig.OPERATING_MARGIN_PCT_RANGE,
	roe: CalibrationConfig.ROE_PCT_RANGE,
	roic: CalibrationConfig.ROIC_PCT_RANGE,
	median_upside: CalibrationConfig.UPSIDE_RANGE,
};

const ANCHOR_DIRECTIONS: Record<ScoreAnchorKey, "positive" | "inverse"> = {
	market_cap: "positive",
	peg: "inverse",
	pe: "inverse",
	pe_forward: "inverse",
	ps: "inverse",
	ps_forward: "inverse",
	debt_to_equity: "inverse",
	fcf_yield: "positive",
	shareholder_yield: "positive",
	revenue_growth: "positive",
	gross_margin: "positive",
	operating_margin: "positive",
	roe: "positive",
	roic: "positive",
	median_upside: "positive",
};

let cachedAnchors: ScoreAnchors | null = null;

function calibrationDbPath(): string {
	return path.resolve(
		process.env.EVALUATION_CALIBRATION_SQLITE_PATH ??
			DEFAULT_CALIBRATION_DB_PATH,
	);
}

function percentile(values: number[], percentileValue: number): number | null {
	if (values.length === 0) {
		return null;
	}
	const index = (values.length - 1) * percentileValue;
	const lowerIndex = Math.floor(index);
	const upperIndex = Math.ceil(index);
	if (lowerIndex === upperIndex) {
		return values[lowerIndex] ?? null;
	}
	const lowerValue = values[lowerIndex];
	const upperValue = values[upperIndex];
	if (lowerValue == null || upperValue == null) {
		return null;
	}
	return lowerValue + (upperValue - lowerValue) * (index - lowerIndex);
}

function calibrationQuery(anchorKey: ScoreAnchorKey): {
	expression: string;
	whereClause: string;
} {
	if (anchorKey === "fcf_yield") {
		return {
			expression: "free_cash_flow / market_cap * 100",
			whereClause:
				"market_cap IS NOT NULL AND market_cap > 0 AND free_cash_flow IS NOT NULL",
		};
	}
	return {
		expression: anchorKey,
		whereClause: `${anchorKey} IS NOT NULL`,
	};
}

function calibrationValues(
	database: DatabaseSync,
	anchorKey: ScoreAnchorKey,
): number[] {
	const { expression, whereClause } = calibrationQuery(anchorKey);
	return database
		.prepare(
			`SELECT ${expression} AS value FROM calibration_stats WHERE ${whereClause} ORDER BY value`,
		)
		.all()
		.map((row) => (row as { value: unknown }).value)
		.filter(
			(value): value is number =>
				typeof value === "number" && Number.isFinite(value),
		);
}

function dynamicAnchor(
	database: DatabaseSync,
	anchorKey: ScoreAnchorKey,
): MinMedMax {
	const fallback = STATIC_SCORE_ANCHORS[anchorKey];
	if (anchorKey === "market_cap") {
		return fallback;
	}
	try {
		const values = calibrationValues(database, anchorKey);
		if (values.length < MIN_DYNAMIC_ANCHOR_SAMPLE_SIZE) {
			return fallback;
		}
		const percentileSet =
			ANCHOR_DIRECTIONS[anchorKey] === "inverse"
				? INVERSE_PERCENTILES
				: POSITIVE_PERCENTILES;
		const anchors = percentileSet.map((percentileValue) =>
			percentile(values, percentileValue),
		);
		return [
			anchors[0] ?? fallback[0],
			anchors[1] ?? fallback[1],
			anchors[2] ?? fallback[2],
		];
	} catch {
		return fallback;
	}
}

function loadDynamicAnchors(): ScoreAnchors {
	let database: DatabaseSync | null = null;
	try {
		database = new DatabaseSync(calibrationDbPath(), { readOnly: true });
		return {
			market_cap: dynamicAnchor(database, "market_cap"),
			peg: dynamicAnchor(database, "peg"),
			pe: dynamicAnchor(database, "pe"),
			pe_forward: dynamicAnchor(database, "pe_forward"),
			ps: dynamicAnchor(database, "ps"),
			ps_forward: dynamicAnchor(database, "ps_forward"),
			debt_to_equity: dynamicAnchor(database, "debt_to_equity"),
			fcf_yield: dynamicAnchor(database, "fcf_yield"),
			shareholder_yield: dynamicAnchor(database, "shareholder_yield"),
			revenue_growth: dynamicAnchor(database, "revenue_growth"),
			gross_margin: dynamicAnchor(database, "gross_margin"),
			operating_margin: dynamicAnchor(database, "operating_margin"),
			roe: dynamicAnchor(database, "roe"),
			roic: dynamicAnchor(database, "roic"),
			median_upside: dynamicAnchor(database, "median_upside"),
		};
	} catch {
		return STATIC_SCORE_ANCHORS;
	} finally {
		database?.close();
	}
}

export function getScoreAnchors(): ScoreAnchors {
	cachedAnchors ??= loadDynamicAnchors();
	return cachedAnchors;
}

export function resetScoreAnchorsForTest(): void {
	cachedAnchors = null;
}
