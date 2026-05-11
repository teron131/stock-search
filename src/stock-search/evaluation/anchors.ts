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
const SECTOR_POSITIVE_PERCENTILES = [0.1, 0.5, 0.9] as const;
const SECTOR_INVERSE_PERCENTILES = [0.1, 0.5, 0.9] as const;
const MIN_DYNAMIC_ANCHOR_SAMPLE_SIZE = 50;
const MIN_SECTOR_ANCHOR_SAMPLE_SIZE = 15;
const DEFAULT_CALIBRATION_DB_PATH = path.resolve(
	"data/evaluation_calibration.db",
);

type PercentileSet = readonly [number, number, number];
type DynamicAnchorOptions = {
	fallback?: MinMedMax;
	minSampleSize?: number;
	sectorName?: string | null;
};

export type ScoreAnchorKey =
	| "market_cap"
	| "peg"
	| "pe"
	| "pe_forward"
	| "ps"
	| "ps_forward"
	| "debt_to_equity"
	| "free_cash_flow"
	| "fcf_yield"
	| "shareholder_yield"
	| "revenue"
	| "revenue_growth"
	| "eps_growth"
	| "gross_margin"
	| "operating_margin"
	| "roe"
	| "roic"
	| "median_upside";

export type ScoreAnchors = Record<ScoreAnchorKey, MinMedMax>;
export type AnchorContext = Record<string, unknown> | null | undefined;

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
	free_cash_flow: CalibrationConfig.FREE_CASH_FLOW_RANGE,
	fcf_yield: CalibrationConfig.FCF_YIELD_PCT_RANGE,
	shareholder_yield: CalibrationConfig.SHAREHOLDER_YIELD_PCT_RANGE,
	revenue: CalibrationConfig.REVENUE_RANGE,
	revenue_growth: CalibrationConfig.REVENUE_GROWTH_PCT_RANGE,
	eps_growth: CalibrationConfig.EPS_GROWTH_PCT_RANGE,
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
	free_cash_flow: "positive",
	fcf_yield: "positive",
	shareholder_yield: "positive",
	revenue: "positive",
	revenue_growth: "positive",
	eps_growth: "positive",
	gross_margin: "positive",
	operating_margin: "positive",
	roe: "positive",
	roic: "positive",
	median_upside: "positive",
};

const SECTOR_VALUATION_ANCHOR_KEYS = [
	"peg",
	"pe",
	"pe_forward",
	"debt_to_equity",
	"fcf_yield",
	"shareholder_yield",
	"eps_growth",
	"operating_margin",
	"roic",
] as const satisfies readonly ScoreAnchorKey[];

let cachedAnchors: ScoreAnchors | null = null;
let cachedSectorValuationAnchors = new Map<string, ScoreAnchors>();

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
	if (anchorKey === "free_cash_flow") {
		return {
			expression: "free_cash_flow",
			whereClause: "free_cash_flow IS NOT NULL",
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
	sectorName: string | null = null,
): number[] {
	const { expression, whereClause } = calibrationQuery(anchorKey);
	const sectorClause = sectorName == null ? "" : " AND sector_name = ?";
	const parameters = sectorName == null ? [] : [sectorName];
	return database
		.prepare(
			`SELECT ${expression} AS value FROM calibration_stats WHERE ${whereClause}${sectorClause} ORDER BY value`,
		)
		.all(...parameters)
		.map((row) => (row as { value: unknown }).value)
		.filter(
			(value): value is number =>
				typeof value === "number" && Number.isFinite(value),
		);
}

function dynamicAnchor(
	database: DatabaseSync,
	anchorKey: ScoreAnchorKey,
	options: DynamicAnchorOptions = {},
): MinMedMax {
	const fallback = options.fallback ?? STATIC_SCORE_ANCHORS[anchorKey];
	if (anchorKey === "market_cap" && options.sectorName == null) {
		return fallback;
	}
	try {
		const values = calibrationValues(database, anchorKey, options.sectorName);
		if (
			values.length < (options.minSampleSize ?? MIN_DYNAMIC_ANCHOR_SAMPLE_SIZE)
		) {
			return fallback;
		}
		const percentileSet = anchorPercentiles(anchorKey, options.sectorName);
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

function anchorPercentiles(
	anchorKey: ScoreAnchorKey,
	sectorName: string | null | undefined,
): PercentileSet {
	if (ANCHOR_DIRECTIONS[anchorKey] === "inverse") {
		return sectorName == null
			? INVERSE_PERCENTILES
			: SECTOR_INVERSE_PERCENTILES;
	}
	return sectorName == null
		? POSITIVE_PERCENTILES
		: SECTOR_POSITIVE_PERCENTILES;
}

function sectorNameFromContext(context: AnchorContext): string | null {
	const sectorName = context?.sector_name ?? context?.sectorName;
	return typeof sectorName === "string" && sectorName.trim()
		? sectorName.trim()
		: null;
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
			free_cash_flow: dynamicAnchor(database, "free_cash_flow"),
			fcf_yield: dynamicAnchor(database, "fcf_yield"),
			shareholder_yield: dynamicAnchor(database, "shareholder_yield"),
			revenue: dynamicAnchor(database, "revenue"),
			revenue_growth: dynamicAnchor(database, "revenue_growth"),
			eps_growth: dynamicAnchor(database, "eps_growth"),
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

function loadSectorValuationAnchors(sectorName: string): ScoreAnchors {
	const globalAnchors = getScoreAnchors();
	let database: DatabaseSync | null = null;
	try {
		database = new DatabaseSync(calibrationDbPath(), { readOnly: true });
		const anchors: ScoreAnchors = { ...globalAnchors };
		for (const anchorKey of SECTOR_VALUATION_ANCHOR_KEYS) {
			anchors[anchorKey] = dynamicAnchor(database, anchorKey, {
				fallback: globalAnchors[anchorKey],
				minSampleSize: MIN_SECTOR_ANCHOR_SAMPLE_SIZE,
				sectorName,
			});
		}
		return anchors;
	} catch {
		return globalAnchors;
	} finally {
		database?.close();
	}
}

export function getValuationScoreAnchors(context: AnchorContext): ScoreAnchors {
	const sectorName = sectorNameFromContext(context);
	if (sectorName == null) {
		return getScoreAnchors();
	}
	let anchors = cachedSectorValuationAnchors.get(sectorName);
	if (anchors == null) {
		anchors = loadSectorValuationAnchors(sectorName);
		cachedSectorValuationAnchors.set(sectorName, anchors);
	}
	return anchors;
}

export function resetScoreAnchorsForTest(): void {
	cachedAnchors = null;
	cachedSectorValuationAnchors = new Map();
}
