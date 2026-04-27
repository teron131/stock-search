/** Build portfolio payloads with cache-aware live refresh and ETF lookthrough. */

import type { BackendStore, PositionRow, StockEntry } from "./api/data-store.js";
import { asNumber, normalizeTicker, nowIso, uniqueTickers } from "./utils.js";
import { isCacheTimestampFresh } from "./cache.js";
import { clamp, safeFloat } from "./common-utils.js";
import { agetLabels } from "./labeler.js";
import {
	bucketFromEvaluation,
	normalizeEvaluationRow,
} from "./evaluation/normalization.js";
import {
	CalibrationConfig,
	DEFAULT_BEAR_PROBABILITY,
	DEFAULT_BULL_PROBABILITY,
	DEFAULT_SCORE,
} from "./evaluation/constants.js";
import {
	classifyAndResolveEtfs,
	normalizeSectorName,
	type EtfResolutionResult,
} from "./etf.js";
import {
	aggregateTickerDataSource,
	generatedAtIso,
	resolveTickerStatsMap,
	type StatsResolutionResult,
} from "./stats-resolver.js";
import { fetchYahooIndicators, fetchYahooSymbolMetadata } from "./indicators.js";

export type PortfolioScope = "priority" | "all_cached" | "portfolio_live" | "all";

const CACHE_SCOPES = new Set<PortfolioScope>(["priority", "all_cached"]);
const LIVE_SCOPES = new Set<PortfolioScope>(["portfolio_live", "all"]);
const ALL_UNIVERSE_SCOPES = new Set<PortfolioScope>(["all_cached", "all"]);
const PORTFOLIO_LABEL_FIELD = "industry_labels";
const LABEL_FETCHED_AT_FIELD = "industry_labels_fetched_at";
const LABEL_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const EVAL_KEYS = [
	"overall_score",
	"quality_score",
	"valuation_score",
	"moat_score",
	"upside_score",
	"market_cap_score",
	"bull_probability",
	"bear_probability",
] as const;

function normalizeLabels(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return [...new Set(value.map((label) => String(label ?? "").trim()).filter(Boolean))];
}

function portfolioTickers(positions: PositionRow[]): string[] {
	return uniqueTickers(positions.map((position) => position.ticker));
}

async function forgetRemovedPortfolioTickers(
	store: BackendStore,
	previousTickers: string[],
	nextPositions: PositionRow[],
): Promise<void> {
	const nextTickers = new Set(portfolioTickers(nextPositions));
	const removedTickers = previousTickers.filter((ticker) => !nextTickers.has(ticker));
	if (removedTickers.length === 0) {
		return;
	}

	await Promise.all([
		store.deleteStocksByTickers(removedTickers),
		store.deleteNewsByTickers(removedTickers),
	]);
}

export async function savePortfolioPositionsAndForgetRemoved(
	store: BackendStore,
	positions: PositionRow[],
	previousTickers: string[],
): Promise<void> {
	await store.savePositions(positions);
	await forgetRemovedPortfolioTickers(store, previousTickers, positions);
}

function computeMissingLabels(
	tickers: string[],
	stocksMap: Record<string, StockEntry>,
	now: number,
): string[] {
	return tickers.filter((ticker) => {
		const stockEntry = stocksMap[ticker];
		const labels = normalizeLabels(
			stockEntry?.indicators[PORTFOLIO_LABEL_FIELD] ?? stockEntry?.labels,
		);
		const labelsAreFresh = isCacheTimestampFresh(
			stockEntry?.indicators[LABEL_FETCHED_AT_FIELD],
			now,
			LABEL_CACHE_MAX_AGE_MS,
		);
		return labels.length === 0 || !labelsAreFresh;
	});
}

async function resolvePortfolioLabels(
	store: BackendStore,
	positions: PositionRow[],
	stocksMap: Record<string, StockEntry>,
	fetchMissing: boolean,
): Promise<Record<string, string[]>> {
	const tickers = portfolioTickers(positions);
	if (tickers.length === 0) {
		return {};
	}

	const now = Date.now();
	const labelsByTicker: Record<string, string[]> = {};
	for (const ticker of tickers) {
		const stockEntry = stocksMap[ticker];
		labelsByTicker[ticker] = normalizeLabels(
			stockEntry?.indicators[PORTFOLIO_LABEL_FIELD] ?? stockEntry?.labels,
		);
	}

	const missing = fetchMissing ? computeMissingLabels(tickers, stocksMap, now) : [];
	if (missing.length === 0) {
		return labelsByTicker;
	}

	const fetched = await agetLabels(missing, { maxConcurrency: 4 });
	const upserts: Array<{
		ticker: string;
		indicators?: Record<string, unknown>;
		evaluation?: Record<string, unknown>;
		labels?: string[];
	}> = [];
	for (const ticker of missing) {
		const result = fetched[ticker];
		const labels = normalizeLabels(result?.labels ?? []);
		if (labels.length === 0) {
			continue;
		}
		labelsByTicker[ticker] = labels;
		const existing = stocksMap[ticker];
		const indicators = {
			...(existing?.indicators ?? {}),
			[PORTFOLIO_LABEL_FIELD]: labels,
			[LABEL_FETCHED_AT_FIELD]: new Date(now).toISOString(),
		};
		stocksMap[ticker] = {
			indicators,
			evaluation: existing?.evaluation ?? {},
			labels,
		};
		upserts.push({
			ticker,
			indicators,
			evaluation: existing?.evaluation ?? {},
			labels,
		});
	}

	if (upserts.length > 0) {
		await store.upsertStocks(upserts);
	}

	return labelsByTicker;
}

function findPositionIndex(positions: PositionRow[], ticker: string): number {
	const normalizedTicker = normalizeTicker(ticker);
	return positions.findIndex(
		(position) => normalizeTicker(position.ticker) === normalizedTicker,
	);
}

function hasOwnEvaluation(
	evaluation: Record<string, unknown> | null | undefined,
): boolean {
	if (!evaluation) {
		return false;
	}
	return EVAL_KEYS.some((key) => evaluation[key] != null && evaluation[key] !== "");
}

function mapLinear(
	value: number | null,
	{
		inMin,
		inMax,
		outMin,
		outMax,
	}: {
		inMin: number;
		inMax: number;
		outMin: number;
		outMax: number;
	},
): number | null {
	if (value == null || inMax === inMin) {
		return null;
	}
	const ratio = (value - inMin) / (inMax - inMin);
	return outMin + ratio * (outMax - outMin);
}

function indicatorEvalFallback(
	indicators: Record<string, unknown>,
): Record<(typeof EVAL_KEYS)[number], number> {
	const peForward = safeFloat(indicators.pe_forward);
	const pe = safeFloat(indicators.pe);
	const revenueGrowth = safeFloat(indicators.revenue_growth);
	const grossMargin = safeFloat(indicators.gross_margin);
	const medianUpside = safeFloat(indicators.median_upside);
	const [peFwdMin, , peFwdMax] = CalibrationConfig.FORWARD_PE_RANGE;
	const [peMin, , peMax] = CalibrationConfig.TRAILING_PE_RANGE;
	const [revGMin, , revGMax] = CalibrationConfig.REVENUE_GROWTH_PCT_RANGE;
	const [marginMin, , marginMax] = CalibrationConfig.GROSS_MARGIN_PCT_RANGE;
	const [upsideMin, , upsideMax] = CalibrationConfig.UPSIDE_RANGE;

	const valuationParts = [
		mapLinear(peForward, {
			inMin: peFwdMin,
			inMax: peFwdMax,
			outMin: 10,
			outMax: 2,
		}),
		mapLinear(pe, {
			inMin: peMin,
			inMax: peMax,
			outMin: 10,
			outMax: 2,
		}),
	].filter((value): value is number => value != null);
	const valuation = valuationParts.length
		? clamp(
				valuationParts.reduce((sum, value) => sum + value, 0) /
					valuationParts.length,
				0,
				10,
			)
		: DEFAULT_SCORE;

	const qualityParts = [
		mapLinear(revenueGrowth, {
			inMin: revGMin,
			inMax: revGMax,
			outMin: 2,
			outMax: 10,
		}),
		mapLinear(grossMargin, {
			inMin: marginMin,
			inMax: marginMax,
			outMin: 2,
			outMax: 10,
		}),
	].filter((value): value is number => value != null);
	const quality = qualityParts.length
		? clamp(
				qualityParts.reduce((sum, value) => sum + value, 0) /
					qualityParts.length,
				0,
				10,
			)
		: DEFAULT_SCORE;

	const upsideValue = mapLinear(medianUpside, {
		inMin: upsideMin,
		inMax: upsideMax,
		outMin: 2,
		outMax: 10,
	});
	const upside =
		upsideValue == null ? DEFAULT_SCORE : clamp(upsideValue, 0, 10);
	const moat = DEFAULT_SCORE;
	const overall = clamp((moat + quality + valuation + upside) / 4, 0, 10);

	const momentumFields = [
		"change_percent_1d",
		"change_percent_1m",
		"change_percent_3m",
		"change_percent_6m",
		"change_percent_1y",
	] as const;
	const momentumValues = momentumFields
		.map((field) => safeFloat(indicators[field]))
		.filter((value): value is number => value != null);
	let bull = DEFAULT_BULL_PROBABILITY;
	let bear = DEFAULT_BEAR_PROBABILITY;
	if (momentumValues.length > 0) {
		const avgMomentum =
			momentumValues.reduce((sum, value) => sum + value, 0) /
			momentumValues.length;
		bull = Math.max(0, Math.min(1, 0.5 + avgMomentum / 100));
		bear = Math.max(0, Math.min(1, 0.2 - avgMomentum / 200));
	}

	return {
		overall_score: Number(overall.toFixed(2)),
		quality_score: Number(quality.toFixed(2)),
		valuation_score: Number(valuation.toFixed(2)),
		moat_score: Number(moat.toFixed(2)),
		upside_score: Number(upside.toFixed(2)),
		market_cap_score: DEFAULT_SCORE,
		bull_probability: Number(bull.toFixed(4)),
		bear_probability: Number(bear.toFixed(4)),
	};
}

function pickEvalValue(
	{
		evaluation,
		normalizedEvaluation,
		fallbackEvaluation,
		key,
		aliases = [],
	}: {
		evaluation: Record<string, unknown>;
		normalizedEvaluation: Record<string, number>;
		fallbackEvaluation: Record<(typeof EVAL_KEYS)[number], number>;
		key: (typeof EVAL_KEYS)[number];
		aliases?: readonly string[];
	},
): [number, boolean] {
	const hasLlmValue = [key, ...aliases].some(
		(alias) => evaluation[alias] != null,
	);
	if (hasLlmValue && normalizedEvaluation[key] != null) {
		return [Number(normalizedEvaluation[key]), true];
	}
	return [fallbackEvaluation[key], false];
}

function positionQuantity(position: PositionRow): number {
	const quantity = Number(position.quantity ?? 0);
	return Number.isFinite(quantity) ? quantity : 0;
}

function mergeIndicatorLabels(
	position: PositionRow,
	indicators: Record<string, unknown>,
	stockLabels: string[],
): string[] {
	const positionLabels = normalizeLabels(position[PORTFOLIO_LABEL_FIELD]);
	if (positionLabels.length > 0) {
		return positionLabels;
	}
	const indicatorLabels = normalizeLabels(indicators.industry_labels);
	return indicatorLabels.length > 0 ? indicatorLabels : stockLabels;
}

function buildRowsForScope(
	positions: PositionRow[],
	stocksMap: Record<string, StockEntry>,
	scope: PortfolioScope,
): PositionRow[] {
	if (!ALL_UNIVERSE_SCOPES.has(scope)) {
		return positions.map((position) => ({ ...position }));
	}

	const rows = positions.map((position) => ({ ...position }));
	const existingTickers = new Set(rows.map((row) => normalizeTicker(row.ticker)));
	for (const ticker of Object.keys(stocksMap)) {
		if (existingTickers.has(ticker)) {
			continue;
		}
		rows.push({ ticker, quantity: 0 });
	}
	return rows;
}

function applyPositionLabels(
	positions: PositionRow[],
	labelsByTicker: Record<string, string[]>,
): void {
	for (const position of positions) {
		const ticker = normalizeTicker(position.ticker);
		if (!ticker) {
			continue;
		}
		position[PORTFOLIO_LABEL_FIELD] = normalizeLabels(labelsByTicker[ticker]);
	}
}

function rankRows(rows: Array<Record<string, unknown>>): void {
	const rankedRows = rows
		.map((row, index) => ({
			index,
			score: asNumber(row.overall_score),
		}))
		.filter((entry): entry is { index: number; score: number } => entry.score != null)
		.sort((left, right) => right.score - left.score);

	for (const [rankIndex, entry] of rankedRows.entries()) {
		rows[entry.index].rank = rankIndex + 1;
	}
}

function mergeLiveResultsIntoStocks(
	stocksMap: Record<string, StockEntry>,
	liveResults: Record<string, StatsResolutionResult>,
): Record<string, StockEntry> {
	const mergedMap: Record<string, StockEntry> = {};
	for (const [ticker, stock] of Object.entries(stocksMap)) {
		mergedMap[ticker] = {
			indicators: { ...(stock.indicators ?? {}) },
			evaluation: { ...(stock.evaluation ?? {}) },
			labels: [...(stock.labels ?? [])],
		};
	}

	for (const [ticker, result] of Object.entries(liveResults)) {
		const existing = mergedMap[ticker];
		mergedMap[ticker] = {
			indicators: {
				...(existing?.indicators ?? {}),
				...result.row,
			},
			evaluation: existing?.evaluation ?? {},
			labels: existing?.labels ?? [],
		};
	}
	return mergedMap;
}

function weightedAverage(
	rows: Array<Record<string, unknown>>,
	fieldName: string,
): number | null {
	let weightedSum = 0;
	let totalWeight = 0;

	for (const row of rows) {
		const total = asNumber(row.total);
		const value = asNumber(row[fieldName]);
		if (total == null || total <= 0 || value == null) {
			continue;
		}
		weightedSum += total * value;
		totalWeight += total;
	}

	return totalWeight > 0 ? weightedSum / totalWeight : null;
}

function normalizeWeightsTo100(
	weights: Record<string, number>,
	decimals = 4,
): Record<string, number> {
	const entries = Object.entries(weights);
	if (entries.length === 0) {
		return {};
	}
	const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
	if (total <= 0) {
		return Object.fromEntries(
			entries.map(([ticker, weight]) => [ticker, Number(weight.toFixed(decimals))]),
		);
	}
	const rounded = Object.fromEntries(
		entries.map(([ticker, weight]) => [ticker, Number(weight.toFixed(decimals))]),
	);
	const adjustment = Number(
		(100 - Object.values(rounded).reduce((sum, value) => sum + value, 0)).toFixed(
			decimals,
		),
	);
	if (adjustment === 0) {
		return rounded;
	}
	const largestTicker = Object.entries(rounded).sort((left, right) => right[1] - left[1])[0]?.[0];
	if (largestTicker) {
		rounded[largestTicker] = Number(
			(rounded[largestTicker] + adjustment).toFixed(decimals),
		);
	}
	return rounded;
}

async function fetchEquitySector(
	ticker: string,
	rowByTicker: Map<string, Record<string, unknown>>,
): Promise<[string, string]> {
	const row = rowByTicker.get(ticker);
	const rawSector =
		typeof row?.sector_name === "string" && row.sector_name.trim()
			? row.sector_name
			: typeof row?.industry_name === "string" && row.industry_name.trim()
				? row.industry_name
				: null;
	if (rawSector) {
		return [ticker, normalizeSectorName(rawSector)];
	}

	const metadata = await fetchYahooSymbolMetadata(ticker);
	return [
		ticker,
		normalizeSectorName(
			typeof metadata.sector_name === "string" && metadata.sector_name.trim()
				? metadata.sector_name
				: typeof metadata.industry_name === "string" && metadata.industry_name.trim()
					? metadata.industry_name
					: null,
		),
	];
}

async function buildEtfTables(
	rows: Array<Record<string, unknown>>,
	resolution: EtfResolutionResult,
	targetTickers: string[],
): Promise<{
	tickerTable: Array<Record<string, unknown>>;
	sectorTable: Array<Record<string, unknown>>;
	meta: Record<string, number>;
}> {
	const rowByTicker = new Map(
		rows.map((row) => [normalizeTicker(row.ticker), row] as const),
	);
	const stockTickers = resolution.stockPositions.map((position) =>
		normalizeTicker(position.ticker),
	);
	const etfTickers = resolution.etfPositions.map((position) =>
		normalizeTicker(position.ticker),
	);
	const portfolioTotal = targetTickers.reduce((sum, ticker) => {
		return sum + (safeFloat(rowByTicker.get(ticker)?.total) ?? 0);
	}, 0);
	const directWeights = Object.fromEntries(
		targetTickers.map((ticker) => {
			const total = safeFloat(rowByTicker.get(ticker)?.total) ?? 0;
			return [ticker, portfolioTotal > 0 ? (total / portfolioTotal) * 100 : 0];
		}),
	);
	const etfAllocation = Object.fromEntries(
		etfTickers.map((ticker) => {
			const total = safeFloat(rowByTicker.get(ticker)?.total) ?? 0;
			return [ticker, portfolioTotal > 0 ? (total / portfolioTotal) * 100 : 0];
		}),
	);
	const tickerExposure = Object.fromEntries(
		targetTickers.map((ticker) => [
			ticker,
			{
				direct_weight: directWeights[ticker] ?? 0,
				etf_lookthrough_weight: 0,
				combined_weight: directWeights[ticker] ?? 0,
			},
		]),
	) as Record<
		string,
		{
			direct_weight: number;
			etf_lookthrough_weight: number;
			combined_weight: number;
		}
	>;
	const etfDistributedWeights = Object.fromEntries(
		etfTickers.map((ticker) => [ticker, 0]),
	) as Record<string, number>;
	const etfSectorExposure: Record<string, number> = {};

	for (const etfTicker of etfTickers) {
		const snapshot = resolution.snapshotByTicker[etfTicker];
		if (!snapshot) {
			continue;
		}
		const etfWeight = etfAllocation[etfTicker] ?? 0;
		for (const holding of snapshot.holdings) {
			const holdingTicker = normalizeTicker(holding.ticker);
			if (!tickerExposure[holdingTicker]) {
				continue;
			}
			const contribution = etfWeight * (holding.weight / 100);
			tickerExposure[holdingTicker].etf_lookthrough_weight += contribution;
			tickerExposure[holdingTicker].combined_weight += contribution;
			etfDistributedWeights[etfTicker] =
				(etfDistributedWeights[etfTicker] ?? 0) + contribution;
		}
		for (const sector of snapshot.sectors) {
			const contribution = etfWeight * (sector.weight / 100);
			etfSectorExposure[sector.name] =
				(etfSectorExposure[sector.name] ?? 0) + contribution;
		}
	}

	for (const etfTicker of etfTickers) {
		if (tickerExposure[etfTicker]) {
			tickerExposure[etfTicker].combined_weight -=
				etfDistributedWeights[etfTicker] ?? 0;
		}
	}

	const normalizedDirectWeights = normalizeWeightsTo100(
		Object.fromEntries(
			Object.entries(tickerExposure).map(([ticker, data]) => [
				ticker,
				data.direct_weight,
			]),
		),
	);
	const normalizedCombinedWeights = normalizeWeightsTo100(
		Object.fromEntries(
			Object.entries(tickerExposure).map(([ticker, data]) => [
				ticker,
				data.combined_weight,
			]),
		),
	);
	for (const [ticker, data] of Object.entries(tickerExposure)) {
		data.direct_weight = normalizedDirectWeights[ticker] ?? 0;
		data.etf_lookthrough_weight = Number(data.etf_lookthrough_weight.toFixed(4));
		data.combined_weight = normalizedCombinedWeights[ticker] ?? 0;
	}

	const stockSectorExposure: Record<string, number> = {};
	const stockSectorResults = await Promise.all(
		[...new Set(stockTickers)].map((ticker) => fetchEquitySector(ticker, rowByTicker)),
	);
	for (const [ticker, sector] of stockSectorResults) {
		const directWeight = normalizedDirectWeights[ticker] ?? 0;
		stockSectorExposure[sector] = (stockSectorExposure[sector] ?? 0) + directWeight;
	}

	const tickerTable = Object.entries(tickerExposure)
		.map(([ticker, data]) => ({
			ticker,
			direct_weight: Number(data.direct_weight.toFixed(4)),
			etf_lookthrough_weight: Number(data.etf_lookthrough_weight.toFixed(4)),
			combined_weight: Number(data.combined_weight.toFixed(4)),
		}))
		.sort((left, right) => right.combined_weight - left.combined_weight);

	const combinedSectorExposure = { ...etfSectorExposure };
	for (const [sector, weight] of Object.entries(stockSectorExposure)) {
		combinedSectorExposure[sector] = (combinedSectorExposure[sector] ?? 0) + weight;
	}
	const etfSleeveTotal = Object.values(etfSectorExposure).reduce((sum, value) => sum + value, 0);
	const sectorTable = Object.entries(combinedSectorExposure)
		.map(([sector, weight]) => ({
			sector,
			stock_weight: Number((stockSectorExposure[sector] ?? 0).toFixed(4)),
			etf_lookthrough_weight: Number((etfSectorExposure[sector] ?? 0).toFixed(4)),
			portfolio_weight: Number(weight.toFixed(4)),
			within_etf_sleeve_weight:
				etfSleeveTotal > 0
					? Number(
							(((etfSectorExposure[sector] ?? 0) / etfSleeveTotal) * 100).toFixed(4),
						)
					: 0,
		}))
		.sort((left, right) => right.portfolio_weight - left.portfolio_weight);

	return {
		tickerTable,
		sectorTable,
		meta: {
			direct_weight_total: Number(
				tickerTable.reduce((sum, row) => sum + Number(row.direct_weight), 0).toFixed(4),
			),
			combined_weight_total: Number(
				tickerTable.reduce((sum, row) => sum + Number(row.combined_weight), 0).toFixed(4),
			),
			sector_portfolio_total: Number(
				sectorTable.reduce((sum, row) => sum + Number(row.portfolio_weight), 0).toFixed(4),
			),
			within_etf_sleeve_total: Number(
				sectorTable
					.reduce((sum, row) => sum + Number(row.within_etf_sleeve_weight), 0)
					.toFixed(4),
			),
		},
	};
}

function buildSectorDistribution(
	rows: Array<Record<string, unknown>>,
	resolution: EtfResolutionResult,
): Array<{
	sector: string;
	portfolio_weight: number;
	stock_weight: number;
	etf_lookthrough_weight: number;
}> {
	const directExposure = new Map<string, number>();
	const etfExposure = new Map<string, number>();
	const rowByTicker = new Map(
		rows.map((row) => [normalizeTicker(row.ticker), row] as const),
	);

	for (const row of rows) {
		if (Number(row.quantity ?? 0) <= 0) {
			continue;
		}
		if (String(row.equity_type ?? "").toUpperCase() === "ETF") {
			continue;
		}
		const weight = Number(row.weight_pct ?? 0);
		if (!Number.isFinite(weight) || weight <= 0) {
			continue;
		}
		const sector = normalizeSectorName(
			typeof row.sector_name === "string" ? row.sector_name : null,
		);
		directExposure.set(sector, (directExposure.get(sector) ?? 0) + weight);
	}

	for (const position of resolution.etfPositions) {
		const ticker = normalizeTicker(position.ticker);
		const row = rowByTicker.get(ticker);
		const sleeveWeight = Number(row?.weight_pct ?? 0);
		if (!Number.isFinite(sleeveWeight) || sleeveWeight <= 0) {
			continue;
		}
		const snapshot = resolution.snapshotByTicker[ticker];
		for (const sector of snapshot?.sectors ?? []) {
			const contribution = sleeveWeight * (sector.weight / 100);
			etfExposure.set(
				sector.name,
				(etfExposure.get(sector.name) ?? 0) + contribution,
			);
		}
	}

	const allSectors = new Set([...directExposure.keys(), ...etfExposure.keys()]);
	return [...allSectors]
		.map((sector) => ({
			sector,
			stock_weight: Number((directExposure.get(sector) ?? 0).toFixed(4)),
			etf_lookthrough_weight: Number((etfExposure.get(sector) ?? 0).toFixed(4)),
			portfolio_weight: Number(
				((directExposure.get(sector) ?? 0) + (etfExposure.get(sector) ?? 0)).toFixed(4),
			),
		}))
		.sort((left, right) => right.portfolio_weight - left.portfolio_weight);
}

function calculatePortfolioStats(
	rows: Array<Record<string, unknown>>,
	sectorDistribution: Array<{
		sector: string;
		portfolio_weight: number;
		stock_weight: number;
		etf_lookthrough_weight: number;
	}>,
): Record<string, unknown> {
	const heldRows = rows.filter((row) => Number(row.quantity ?? 0) > 0);
	const total = heldRows.reduce((sum, row) => sum + Number(row.total ?? 0), 0);
	let changeValue = 0;
	for (const row of heldRows) {
		const totalValue = asNumber(row.total);
		const changePercent = asNumber(row.change_percent_1d);
		if (totalValue == null || totalValue <= 0 || changePercent == null) {
			continue;
		}
		changeValue += ((changePercent / 100) * totalValue) / (1 + changePercent / 100);
	}

	const denominator = total - changeValue;
	return {
		held_positions_count: heldRows.length,
		total,
		change: changeValue,
		change_percent: denominator > 0 ? (changeValue / denominator) * 100 : 0,
		weighted_beta: weightedAverage(heldRows, "beta"),
		weighted_iv: weightedAverage(heldRows, "iv"),
		sector_distribution: sectorDistribution,
	};
}

function liveTickersForScope(
	positions: PositionRow[],
	evalTickers: Set<string>,
	scope: PortfolioScope,
): string[] {
	if (!LIVE_SCOPES.has(scope)) {
		return [];
	}
	return uniqueTickers(
		positions
			.filter((position) => {
				const ticker = normalizeTicker(position.ticker);
				return evalTickers.has(ticker) || positionQuantity(position) > 0;
			})
			.map((position) => position.ticker),
	);
}

function syncModeForScope(scope: PortfolioScope): string {
	return LIVE_SCOPES.has(scope) ? "realtime_subscription" : "realtime_subscription";
}

/** Return the cache policy used for one portfolio scope. */
export function cacheControlForScope(scope: PortfolioScope): string {
	return CACHE_SCOPES.has(scope)
		? "private, max-age=30, stale-while-revalidate=300"
		: "no-store";
}

/** Merge one position row with cached indicators and evaluation fields. */
export function mergePortfolioRow(
	position: PositionRow,
	stockEntry: StockEntry | undefined,
): Record<string, unknown> {
	const indicators = stockEntry?.indicators ?? {};
	const evaluation = stockEntry?.evaluation ?? {};
	const ticker = normalizeTicker(position.ticker);
	const quantity = positionQuantity(position);
	const price = asNumber(indicators.price);
	const total = price == null ? 0 : quantity * price;
	const normalizedEvaluation = normalizeEvaluationRow(evaluation);
	const fallbackEvaluation = indicatorEvalFallback(indicators);
	const selectedEvaluation: Record<string, number> = {};
	let llmCount = 0;
	for (const field of EVAL_KEYS) {
		const [value, isFromLlm] = pickEvalValue({
			evaluation,
			normalizedEvaluation,
			fallbackEvaluation,
			key: field,
		});
		selectedEvaluation[field] = value;
		if (isFromLlm) {
			llmCount += 1;
		}
	}
	const evalSource =
		llmCount === EVAL_KEYS.length
			? "llm"
			: llmCount === 0
				? "indicator_fallback"
				: "hybrid";
	const industryLabels = mergeIndicatorLabels(position, indicators, stockEntry?.labels ?? []);
	const quoteType = String(indicators.quote_type ?? "").trim().toUpperCase();
	const etfHoldings = Array.isArray(indicators.etf_holdings)
		? indicators.etf_holdings
		: Array.isArray(indicators.holdings)
			? indicators.holdings
			: [];
	const strategy =
		typeof position.strategy === "string" && position.strategy.trim()
			? position.strategy
			: bucketFromEvaluation(ticker, evaluation) ??
				(typeof indicators.strategy === "string" ? indicators.strategy : null);

	return {
		...indicators,
		...selectedEvaluation,
		...position,
		evaluation_update_tier: "evaluation",
		market_update_tier: "market_data",
		indicator_update_tier: "indicator",
		ratings_update_tier: "ratings",
		etf_holdings_update_tier: etfHoldings.length > 0 ? "etf_holdings" : null,
		eval_source: evalSource,
		ticker,
		quantity,
		total,
		equity_type:
			quoteType === "ETF" ? "ETF" : quoteType ? "STOCK" : "UNKNOWN",
		industry_labels: industryLabels,
		primary_label: industryLabels[0] ?? null,
		etf_holdings: etfHoldings,
		etf_holdings_fetched_at:
			typeof indicators.etf_holdings_fetched_at === "string"
				? indicators.etf_holdings_fetched_at
				: null,
		strategy,
		rank: null,
	};
}

/** Build the public portfolio payload for one scope. */
export async function buildPortfolioPayload(
	store: BackendStore,
	scope: PortfolioScope,
): Promise<{
	rows: Array<Record<string, unknown>>;
	tables: {
		ticker_exposure: Array<Record<string, unknown>>;
		sector_exposure: Array<Record<string, unknown>>;
	};
	portfolio_stats: Record<string, unknown> | null;
	meta: Record<string, unknown> & {
		generated_at: string | null;
		data_source: string;
		backend_store: string;
		sync_mode: string;
	};
}> {
	const portfolio = await store.loadPortfolio();
	const stocksMap = ALL_UNIVERSE_SCOPES.has(scope)
		? await store.loadStocks()
		: await store.loadStocksByTickers(portfolioTickers(portfolio.positions));
	const scopedPositions = buildRowsForScope(portfolio.positions, stocksMap, scope);
	const labelsByTicker = await resolvePortfolioLabels(
		store,
		portfolio.positions,
		stocksMap,
		LIVE_SCOPES.has(scope),
	);
	applyPositionLabels(scopedPositions, labelsByTicker);
	const evalTickers = new Set(
		Object.entries(stocksMap)
			.filter(([, stock]) => hasOwnEvaluation(stock.evaluation))
			.map(([ticker]) => ticker),
	);
	const liveTickers = liveTickersForScope(scopedPositions, evalTickers, scope);
	const liveResults =
		liveTickers.length > 0
			? await resolveTickerStatsMap(store, liveTickers, "auto", stocksMap)
			: {};
	const mergedStocks = mergeLiveResultsIntoStocks(stocksMap, liveResults);

	const rows = scopedPositions.map((position) =>
		mergePortfolioRow(position, mergedStocks[normalizeTicker(position.ticker)]),
	);
	const heldTotal = rows.reduce((sum, row) => {
		return Number(row.quantity ?? 0) > 0 ? sum + Number(row.total ?? 0) : sum;
	}, 0);
	for (const row of rows) {
		const rowTotal = Number(row.total ?? 0);
		row.weight_pct =
			Number(row.quantity ?? 0) > 0 && heldTotal > 0 ? (rowTotal / heldTotal) * 100 : 0;
	}

	const etfResolution = await classifyAndResolveEtfs(
		store,
		portfolio.positions,
		mergedStocks,
		LIVE_SCOPES.has(scope),
	);
	for (const row of rows) {
		const ticker = normalizeTicker(row.ticker);
		const snapshot = etfResolution.snapshotByTicker[ticker];
		if (!snapshot) {
			continue;
		}
		row.equity_type = "ETF";
		row.etf_holdings = snapshot.holdings;
		row.etf_sectors = snapshot.sectors;
		row.etf_holdings_fetched_at =
			typeof mergedStocks[ticker]?.indicators.etf_holdings_fetched_at === "string"
				? mergedStocks[ticker]?.indicators.etf_holdings_fetched_at
				: nowIso();
	}

	rankRows(rows);
	rows.sort((left, right) => Number(right.weight_pct ?? 0) - Number(left.weight_pct ?? 0));
	const heldTickers = portfolio.positions
		.map((position) => normalizeTicker(position.ticker))
		.filter(Boolean);
	const sectorDistribution = buildSectorDistribution(rows, etfResolution);
	const [{ tickerTable, sectorTable, meta: tableMeta }, generatedAt] =
		await Promise.all([
			buildEtfTables(rows, etfResolution, heldTickers),
			LIVE_SCOPES.has(scope)
				? Promise.resolve(generatedAtIso())
				: store.getMetaValue("stats_generated_at"),
		]);
	let dataSource = LIVE_SCOPES.has(scope)
		? aggregateTickerDataSource(liveResults, "auto")
		: "cache";
	if (LIVE_SCOPES.has(scope) && dataSource === "live") {
		const liveTickerSet = new Set(Object.keys(liveResults));
		for (const row of rows) {
			const ticker = normalizeTicker(row.ticker);
			if (ticker && !liveTickerSet.has(ticker)) {
				dataSource = "live_with_cache_fallback";
				break;
			}
		}
	}

	return {
		rows,
		tables: {
			ticker_exposure: tickerTable,
			sector_exposure: sectorTable,
		},
		portfolio_stats: calculatePortfolioStats(rows, sectorDistribution),
		meta: {
			...tableMeta,
			etf_count: etfResolution.etfPositions.length,
			etf_refreshed_count: etfResolution.etfRefreshedCount,
			generated_at: generatedAt,
			data_source: dataSource,
			backend_store: store.backendName,
			sync_mode: syncModeForScope(scope),
		},
	};
}

async function ensureValidNewTicker(ticker: string): Promise<void> {
	const indicators = await fetchYahooIndicators(ticker);
	if (safeFloat(indicators.price) == null) {
		throw new Error(`Invalid ticker: ${ticker}`);
	}
}

/** Apply a position patch for one ticker. */
export async function patchPortfolioPosition(
	store: BackendStore,
	ticker: string,
	patch: {
		quantity?: number | null;
		strategy?: string | null;
	},
): Promise<Record<string, unknown>> {
	const tickerSymbol = normalizeTicker(ticker);
	if (!tickerSymbol) {
		throw new Error(`Invalid ticker: ${ticker}`);
	}

	const positions = await store.loadPositions();
	const previousTickers = portfolioTickers(positions);
	const index = findPositionIndex(positions, tickerSymbol);
	if (index < 0 && patch.quantity === undefined && patch.strategy === undefined) {
		throw new Error("Patch payload is empty.");
	}
	const current =
		index >= 0 ? { ...positions[index] } : ({ ticker: tickerSymbol } as PositionRow);
	if (index < 0) {
		await ensureValidNewTicker(tickerSymbol);
	}

	if (patch.quantity !== undefined) {
		current.quantity = patch.quantity ?? 0;
	}
	if (patch.strategy !== undefined) {
		if (patch.strategy === null || patch.strategy === "") {
			delete current.strategy;
		} else {
			current.strategy = patch.strategy;
		}
	}

	if (index >= 0) {
		positions[index] = current;
	} else {
		positions.push(current);
	}
	await savePortfolioPositionsAndForgetRemoved(store, positions, previousTickers);
	return {
		status: "ok",
		ticker: tickerSymbol,
		position: current,
	};
}

/** Remove one ticker from the portfolio positions list. */
export async function removePortfolioPosition(
	store: BackendStore,
	ticker: string,
): Promise<Record<string, unknown>> {
	const tickerSymbol = normalizeTicker(ticker);
	const positions = await store.loadPositions();
	const previousTickers = portfolioTickers(positions);
	const nextPositions = positions.filter(
		(position) => normalizeTicker(position.ticker) !== tickerSymbol,
	);
	await savePortfolioPositionsAndForgetRemoved(
		store,
		nextPositions,
		previousTickers,
	);
	return { status: "ok", ticker: tickerSymbol };
}

/** Return one merged ticker row from the current cache only. */
export async function getTickerRowFromCache(
	store: BackendStore,
	ticker: string,
): Promise<Record<string, unknown> | null> {
	const tickerSymbol = normalizeTicker(ticker);
	if (!tickerSymbol) {
		return null;
	}

	const [positions, stockEntry] = await Promise.all([
		store.loadPositions(),
		store.loadStock(tickerSymbol),
	]);
	const position =
		positions.find((row) => normalizeTicker(row.ticker) === tickerSymbol) ??
		({ ticker: tickerSymbol, quantity: 0, strategy: null } as PositionRow);
	return mergePortfolioRow(position, stockEntry ?? undefined);
}

/** Load the evaluation map keyed by ticker. */
export async function loadEvalMap(
	store: BackendStore,
	tickers?: string[],
): Promise<Record<string, Record<string, unknown>>> {
	const stocks =
		tickers && tickers.length > 0
			? await store.loadStocksByTickers(tickers)
			: await store.loadStocks();
	return Object.fromEntries(
		Object.entries(stocks).map(([ticker, stock]) => [ticker, stock.evaluation]),
	);
}

/** Load the indicator map keyed by ticker. */
export async function loadStocksMap(
	store: BackendStore,
	tickers?: string[],
): Promise<Record<string, StockEntry>> {
	return tickers && tickers.length > 0
		? store.loadStocksByTickers(tickers)
		: store.loadStocks();
}
