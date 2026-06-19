/** Load opinionated score anchors from cached backend calibration rows. */

import path from "node:path";

import type { CalibrationStatsRow } from "../storage/index.js";
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
const DEFAULT_CALIBRATION_DB_PATH = path.resolve("data/stock_search.db");

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
	| "rd_knowledge_capital"
	| "rd_intensity"
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
	rd_knowledge_capital: CalibrationConfig.RD_KNOWLEDGE_CAPITAL_RANGE,
	rd_intensity: CalibrationConfig.RD_INTENSITY_PCT_RANGE,
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
	rd_knowledge_capital: "positive",
	rd_intensity: "positive",
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
let cachedCalibrationRows: CalibrationStatsRow[] | null = null;

export function calibrationDbPath(): string {
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

function calibrationValue(
	row: CalibrationStatsRow,
	anchorKey: ScoreAnchorKey,
): number | null {
	if (anchorKey === "fcf_yield") {
		const marketCap = finiteNumber(row.market_cap);
		const freeCashFlow = finiteNumber(row.free_cash_flow);
		if (marketCap == null || marketCap <= 0 || freeCashFlow == null) {
			return null;
		}
		return (freeCashFlow / marketCap) * 100;
	}
	return finiteNumber(row[anchorKey]);
}

function finiteNumber(value: unknown): number | null {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function calibrationValues(
	rows: CalibrationStatsRow[],
	anchorKey: ScoreAnchorKey,
	sectorName: string | null = null,
): number[] {
	return rows
		.filter((row) => sectorName == null || row.sector_name === sectorName)
		.map((row) => calibrationValue(row, anchorKey))
		.filter((value): value is number => value != null)
		.sort((left, right) => left - right);
}

function dynamicAnchor(
	rows: CalibrationStatsRow[],
	anchorKey: ScoreAnchorKey,
	options: DynamicAnchorOptions = {},
): MinMedMax {
	const fallback = options.fallback ?? STATIC_SCORE_ANCHORS[anchorKey];
	if (anchorKey === "market_cap" && options.sectorName == null) {
		return fallback;
	}
	const values = calibrationValues(rows, anchorKey, options.sectorName);
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
	if (cachedCalibrationRows == null) {
		return STATIC_SCORE_ANCHORS;
	}
	return {
		market_cap: dynamicAnchor(cachedCalibrationRows, "market_cap"),
		peg: dynamicAnchor(cachedCalibrationRows, "peg"),
		pe: dynamicAnchor(cachedCalibrationRows, "pe"),
		pe_forward: dynamicAnchor(cachedCalibrationRows, "pe_forward"),
		ps: dynamicAnchor(cachedCalibrationRows, "ps"),
		ps_forward: dynamicAnchor(cachedCalibrationRows, "ps_forward"),
		debt_to_equity: dynamicAnchor(cachedCalibrationRows, "debt_to_equity"),
		free_cash_flow: dynamicAnchor(cachedCalibrationRows, "free_cash_flow"),
		fcf_yield: dynamicAnchor(cachedCalibrationRows, "fcf_yield"),
		shareholder_yield: dynamicAnchor(
			cachedCalibrationRows,
			"shareholder_yield",
		),
		rd_knowledge_capital: dynamicAnchor(
			cachedCalibrationRows,
			"rd_knowledge_capital",
		),
		rd_intensity: dynamicAnchor(cachedCalibrationRows, "rd_intensity"),
		revenue: dynamicAnchor(cachedCalibrationRows, "revenue"),
		revenue_growth: dynamicAnchor(cachedCalibrationRows, "revenue_growth"),
		eps_growth: dynamicAnchor(cachedCalibrationRows, "eps_growth"),
		gross_margin: dynamicAnchor(cachedCalibrationRows, "gross_margin"),
		operating_margin: dynamicAnchor(cachedCalibrationRows, "operating_margin"),
		roe: dynamicAnchor(cachedCalibrationRows, "roe"),
		roic: dynamicAnchor(cachedCalibrationRows, "roic"),
		median_upside: dynamicAnchor(cachedCalibrationRows, "median_upside"),
	};
}

export function getScoreAnchors(): ScoreAnchors {
	cachedAnchors ??= loadDynamicAnchors();
	return cachedAnchors;
}

function loadSectorValuationAnchors(sectorName: string): ScoreAnchors {
	const globalAnchors = getScoreAnchors();
	if (cachedCalibrationRows == null) {
		return globalAnchors;
	}
	const anchors: ScoreAnchors = { ...globalAnchors };
	for (const anchorKey of SECTOR_VALUATION_ANCHOR_KEYS) {
		anchors[anchorKey] = dynamicAnchor(cachedCalibrationRows, anchorKey, {
			fallback: globalAnchors[anchorKey],
			minSampleSize: MIN_SECTOR_ANCHOR_SAMPLE_SIZE,
			sectorName,
		});
	}
	return anchors;
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

export function resetScoreAnchorsCache(): void {
	cachedAnchors = null;
	cachedSectorValuationAnchors = new Map();
}

export function setCalibrationStatsRows(rows: CalibrationStatsRow[]): void {
	cachedCalibrationRows = rows;
	resetScoreAnchorsCache();
}

export function resetScoreAnchorsForTest(): void {
	cachedCalibrationRows = null;
	resetScoreAnchorsCache();
}
