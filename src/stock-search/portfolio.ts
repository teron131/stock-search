/** Build portfolio payloads with cache-aware live refresh and ETF lookthrough. */

import type {
	BackendStore,
	PositionRow,
	StockEntry,
} from "./api/data-store.js";
import { isCacheTimestampFresh, parseCacheTimestamp } from "./cache.js";
import { safeFloat } from "./common-utils.js";
import {
	classifyAndResolveEtfs,
	type EtfResolutionResult,
	normalizeSectorName,
} from "./etf.js";
import {
	bucketFromEvaluation,
	deriveEvaluationScores,
} from "./evaluation/normalization.js";
import {
	fetchYahooIndicators,
	fetchYahooSymbolMetadata,
} from "./indicators.js";
import { agetLabels } from "./labeler.js";
import { Notional } from "./models/schemas.js";
import {
	aggregateTickerDataSource,
	resolveTickerStatsMap,
	type StatsResolutionResult,
} from "./stats-resolver.js";
import { asNumber, normalizeTicker, nowIso, uniqueTickers } from "./utils.js";

export type PortfolioScope =
	| "priority"
	| "all_cached"
	| "portfolio_live"
	| "all";

const LIVE_SCOPES = new Set<PortfolioScope>(["portfolio_live", "all"]);
const ALL_UNIVERSE_SCOPES = new Set<PortfolioScope>(["all_cached", "all"]);
const LABEL_REFRESH_SCOPES = new Set<PortfolioScope>(["all"]);
const PORTFOLIO_LABEL_FIELD = "industry_labels";
const LABEL_FETCHED_AT_FIELD = "industry_labels_fetched_at";
const LABEL_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ETF_LOOKTHROUGH_ROW_MIN_WEIGHT = 2;
const ETF_LOOKTHROUGH_ROW_MIN_NOTIONAL_WEIGHT = 0.5;
const ETF_PROXY_MIN_HOLDING_WEIGHT = 0.5;
const ETF_PROXY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ETF_PROXY_TIMESTAMP_FIELDS = [
	"statistics_fetched_at",
	"financials_fetched_at",
] as const;
const NON_STOCK_ETF_HOLDING_SUFFIXES = new Set(["TRS"]);
const NON_US_TICKER_SUFFIXES = new Set([
	"HK",
	"JP",
	"KR",
	"KS",
	"KQ",
	"TT",
	"TW",
]);
const US_EXCHANGE_PREFIXES = new Set(["AMEX", "NASDAQ", "NYSE"]);
type EtfRepresentativePosition = PositionRow & {
	etf_holding_weight: number;
	etf_holding_notional_weight: number;
	etf_source_tickers: string[];
};
const EVAL_KEYS = [
	"overall_score",
	"quality_score",
	"llm_quality_score",
	"valuation_score",
	"moat_score",
	"upside_score",
	"market_cap_score",
	"tactical_score",
] as const;
const STAT_DERIVED_EVAL_KEYS = new Set<(typeof EVAL_KEYS)[number]>([
	"overall_score",
	"quality_score",
	"valuation_score",
	"moat_score",
	"upside_score",
	"market_cap_score",
	"tactical_score",
]);
const ETF_PROXY_STAT_FIELDS = [
	"market_cap",
	"pe",
	"pe_forward",
	"ps",
	"ps_forward",
	"peg",
	"beta",
	"iv",
	"rsi",
	"revenue",
	"revenue_growth",
	"eps_growth",
	"gross_margin",
	"operating_margin",
	"roe",
	"roic",
	"debt_to_equity",
	"free_cash_flow",
	"shareholder_yield",
	"median_upside",
] as const;
const ETF_PROXY_HARMONIC_MEAN_FIELDS = new Set<string>([
	"pe",
	"pe_forward",
	"ps",
	"ps_forward",
]);
const ETF_PROXY_INTERPOLATED_VALUE_FIELDS = new Set<string>([
	"market_cap",
	"revenue",
	"free_cash_flow",
]);
const ETF_PROXY_ZERO_IS_MISSING_FIELDS = new Set<string>(["beta"]);

type EtfProxyAggregation = "coverage_mean" | "harmonic_mean" | "weighted_mean";

function clearEtfMarketCapFields(row: Record<string, unknown>): void {
	const proxiedFields = Array.isArray(row.proxied_stat_fields)
		? row.proxied_stat_fields.map((field) => String(field))
		: [];
	if (!proxiedFields.includes("market_cap")) {
		row.market_cap = null;
	}
	row.fx = null;
}

function normalizeLabels(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return [
		...new Set(
			value.map((label) => String(label ?? "").trim()).filter(Boolean),
		),
	];
}

function portfolioTickers(positions: PositionRow[]): string[] {
	return uniqueTickers(positions.map((position) => position.ticker));
}

function isNonUsTicker(tickerInput: unknown): boolean {
	const ticker = normalizeTicker(tickerInput).replace("-", ".");
	if (!ticker) {
		return false;
	}
	if (/^\d/.test(ticker)) {
		return true;
	}
	const [prefix, prefixedSymbol] = ticker.includes(":")
		? ticker.split(":", 2)
		: ["", ""];
	if (prefixedSymbol) {
		return !US_EXCHANGE_PREFIXES.has(prefix);
	}
	const suffix = ticker.match(/\.([A-Z]{1,4})$/)?.[1];
	return suffix ? NON_US_TICKER_SUFFIXES.has(suffix) : false;
}

async function forgetRemovedPortfolioTickers(
	store: BackendStore,
	previousTickers: string[],
	nextPositions: PositionRow[],
): Promise<void> {
	const nextTickers = new Set(portfolioTickers(nextPositions));
	const removedTickers = previousTickers.filter(
		(ticker) => !nextTickers.has(ticker),
	);
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

	const missing = fetchMissing
		? computeMissingLabels(tickers, stocksMap, now)
		: [];
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
	return EVAL_KEYS.some(
		(key) => evaluation[key] != null && evaluation[key] !== "",
	);
}

function pickEvalValue({
	evaluation,
	normalizedEvaluation,
	key,
	aliases = [],
}: {
	evaluation: Record<string, unknown>;
	normalizedEvaluation: Record<string, number>;
	key: (typeof EVAL_KEYS)[number];
	aliases?: readonly string[];
}): [number | null, boolean] {
	const hasLlmValue = [key, ...aliases].some(
		(alias) => evaluation[alias] != null,
	);
	const normalizedValue = normalizedEvaluation[key];
	if (normalizedValue != null && STAT_DERIVED_EVAL_KEYS.has(key)) {
		return [Number(normalizedValue), false];
	}
	if (hasLlmValue && normalizedValue != null) {
		return [Number(normalizedValue), true];
	}
	return [null, false];
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
	const existingTickers = new Set(
		rows.map((row) => normalizeTicker(row.ticker)),
	);
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
		.filter(
			(entry): entry is { index: number; score: number } => entry.score != null,
		)
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

function applyRowWeights(rows: Array<Record<string, unknown>>): number {
	const heldTotal = rows.reduce((sum, row) => {
		return Number(row.quantity ?? 0) > 0 ? sum + Number(row.total ?? 0) : sum;
	}, 0);
	for (const row of rows) {
		const rowTotal = Number(row.total ?? 0);
		row.weight_pct =
			Number(row.quantity ?? 0) > 0 && heldTotal > 0
				? (rowTotal / heldTotal) * 100
				: 0;
	}
	return heldTotal;
}

function weightPctByTicker(
	rows: Array<Record<string, unknown>>,
): Map<string, number> {
	return new Map(
		rows.map((row) => [
			normalizeTicker(row.ticker),
			asNumber(row.weight_pct) ?? 0,
		]),
	);
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
			entries.map(([ticker, weight]) => [
				ticker,
				Number(weight.toFixed(decimals)),
			]),
		);
	}
	const rounded = Object.fromEntries(
		entries.map(([ticker, weight]) => [
			ticker,
			Number(weight.toFixed(decimals)),
		]),
	);
	const adjustment = Number(
		(
			100 - Object.values(rounded).reduce((sum, value) => sum + value, 0)
		).toFixed(decimals),
	);
	if (adjustment === 0) {
		return rounded;
	}
	const largestTicker = Object.entries(rounded).sort(
		(left, right) => right[1] - left[1],
	)[0]?.[0];
	if (largestTicker) {
		rounded[largestTicker] = Number(
			(rounded[largestTicker] + adjustment).toFixed(decimals),
		);
	}
	return rounded;
}

function resolveRowStrategy(
	ticker: string,
	indicators: Record<string, unknown>,
	evaluation: Record<string, unknown>,
): string | null {
	const cachedStrategy =
		typeof indicators.strategy === "string" && indicators.strategy.trim()
			? indicators.strategy.trim()
			: null;
	return bucketFromEvaluation(ticker, evaluation) ?? cachedStrategy;
}

function getTickerNotional(
	notionalByTicker: Record<string, Notional>,
	ticker: string,
): Notional {
	notionalByTicker[ticker] ??= new Notional();
	return notionalByTicker[ticker];
}

function buildNotionalByTicker(
	rows: Array<Record<string, unknown>>,
	resolution: EtfResolutionResult,
): Record<string, Notional> {
	const notionalByTicker: Record<string, Notional> = {};
	const rowByTicker = new Map(
		rows.map((row) => [normalizeTicker(row.ticker), row] as const),
	);

	for (const row of rows) {
		const ticker = normalizeTicker(row.ticker);
		const total = safeFloat(row.total) ?? 0;
		if (!ticker || total <= 0) {
			continue;
		}
		getTickerNotional(notionalByTicker, ticker).addFromStocks(total);
	}

	for (const etfPosition of resolution.etfPositions) {
		const etfTicker = normalizeTicker(etfPosition.ticker);
		const etfTotal = safeFloat(rowByTicker.get(etfTicker)?.total) ?? 0;
		const snapshot = resolution.snapshotByTicker[etfTicker];
		if (etfTotal <= 0 || !snapshot) {
			continue;
		}
		for (const holding of snapshot.holdings) {
			const holdingTicker = normalizeTicker(holding.ticker);
			if (
				!holdingTicker ||
				!isStockLikeEtfRepresentativeTicker(holdingTicker) ||
				!Number.isFinite(holding.weight)
			) {
				continue;
			}
			getTickerNotional(notionalByTicker, holdingTicker).addFromEtf(
				etfTotal * (holding.weight / 100),
			);
		}
	}

	return Object.fromEntries(
		Object.entries(notionalByTicker).map(([ticker, notional]) => [
			ticker,
			notional.rounded(),
		]),
	);
}

function cachedEtfSnapshot(
	indicators: Record<string, unknown>,
): EtfResolutionResult["snapshotByTicker"][string] | null {
	const holdings = Array.isArray(indicators.etf_holdings)
		? indicators.etf_holdings
				.map((holding) => {
					if (typeof holding !== "object" || holding === null) {
						return null;
					}
					const row = holding as Record<string, unknown>;
					const ticker = normalizeTicker(row.ticker);
					const weight = safeFloat(row.weight);
					if (!ticker || weight == null) {
						return null;
					}
					return {
						ticker,
						name: typeof row.name === "string" ? row.name : null,
						weight,
					};
				})
				.filter((holding) => holding != null)
		: [];
	if (holdings.length === 0) {
		return null;
	}
	const sectors = Array.isArray(indicators.etf_sectors)
		? indicators.etf_sectors
				.map((sector) => {
					if (typeof sector !== "object" || sector === null) {
						return null;
					}
					const row = sector as Record<string, unknown>;
					const name = typeof row.name === "string" ? row.name.trim() : "";
					const weight = safeFloat(row.weight);
					return name && weight != null ? { name, weight } : null;
				})
				.filter((sector) => sector != null)
		: [];
	return { holdings, sectors, error: null };
}

function etfProxyResolutionForRows(
	baseResolution: EtfResolutionResult,
	positions: PositionRow[],
	stocksMap: Record<string, StockEntry>,
): EtfResolutionResult {
	const etfPositions = [...baseResolution.etfPositions];
	const snapshotByTicker = { ...baseResolution.snapshotByTicker };
	const knownEtfs = new Set(
		etfPositions.map((position) => normalizeTicker(position.ticker)),
	);

	for (const position of positions) {
		const ticker = normalizeTicker(position.ticker);
		if (!ticker || knownEtfs.has(ticker)) {
			continue;
		}
		const indicators = stocksMap[ticker]?.indicators ?? {};
		const quoteType = String(indicators.quote_type ?? "")
			.trim()
			.toUpperCase();
		if (quoteType !== "ETF") {
			continue;
		}
		const snapshot = cachedEtfSnapshot(indicators);
		if (!snapshot) {
			continue;
		}
		knownEtfs.add(ticker);
		etfPositions.push(position);
		snapshotByTicker[ticker] = snapshot;
	}

	return {
		...baseResolution,
		etfPositions,
		snapshotByTicker,
	};
}

function isStockLikeEtfRepresentativeTicker(ticker: string): boolean {
	if (!ticker) {
		return false;
	}
	if (/\s/.test(ticker)) {
		return false;
	}
	const [exchangePrefix, tickerBody] = ticker.includes(":")
		? ticker.split(":", 2)
		: ["", ticker];
	if (exchangePrefix && !/^[A-Z]{2,6}$/.test(exchangePrefix)) {
		return false;
	}
	if (/^\d{7,}/.test(tickerBody)) {
		return false;
	}
	const parts = tickerBody.split(/[.-]/);
	const suffix = parts.at(-1);
	if (
		suffix &&
		parts.length > 1 &&
		NON_STOCK_ETF_HOLDING_SUFFIXES.has(suffix)
	) {
		return false;
	}
	return /^[A-Z0-9]{1,6}([.-][A-Z0-9]{1,4})?$/.test(tickerBody);
}

function buildEtfRepresentativePositions(
	resolution: EtfResolutionResult,
	existingTickers: Set<string>,
	etfWeightPctByTicker: Map<string, number>,
): EtfRepresentativePosition[] {
	const representativesByTicker = new Map<string, EtfRepresentativePosition>();

	for (const etfPosition of resolution.etfPositions) {
		const etfTicker = normalizeTicker(etfPosition.ticker);
		const snapshot = resolution.snapshotByTicker[etfTicker];
		const etfWeightPct = etfWeightPctByTicker.get(etfTicker) ?? 0;
		for (const holding of snapshot?.holdings ?? []) {
			const holdingTicker = normalizeTicker(holding.ticker);
			const holdingWeight = safeFloat(holding.weight) ?? 0;
			const holdingNotionalWeight = etfWeightPct * (holdingWeight / 100);
			if (
				Number(etfPosition.quantity ?? 0) <= 0 ||
				etfWeightPct <= 0 ||
				!holdingTicker ||
				existingTickers.has(holdingTicker) ||
				!isStockLikeEtfRepresentativeTicker(holdingTicker) ||
				holdingWeight <= ETF_LOOKTHROUGH_ROW_MIN_WEIGHT
			) {
				continue;
			}

			const existing = representativesByTicker.get(holdingTicker);
			if (existing) {
				existing.etf_holding_notional_weight += holdingNotionalWeight;
				existing.etf_holding_weight = Math.max(
					existing.etf_holding_weight,
					holdingWeight,
				);
				if (etfTicker && !existing.etf_source_tickers.includes(etfTicker)) {
					existing.etf_source_tickers.push(etfTicker);
				}
				continue;
			}

			representativesByTicker.set(holdingTicker, {
				ticker: holdingTicker,
				name: holding.name,
				quantity: 0,
				etf_lookthrough_only: true,
				etf_holding_weight: holdingWeight,
				etf_holding_notional_weight: holdingNotionalWeight,
				etf_source_tickers: etfTicker ? [etfTicker] : [],
			});
		}
	}

	return [...representativesByTicker.values()].filter(
		(position) =>
			position.etf_holding_notional_weight >
			ETF_LOOKTHROUGH_ROW_MIN_NOTIONAL_WEIGHT,
	);
}

function etfProxyHoldingsForTicker(
	resolution: EtfResolutionResult,
	etfTickerInput: string,
): Array<{ ticker: string; weight: number }> {
	const etfTicker = normalizeTicker(etfTickerInput);
	const snapshot = resolution.snapshotByTicker[etfTicker];
	return (snapshot?.holdings ?? [])
		.map((holding) => ({
			ticker: normalizeTicker(holding.ticker),
			weight: safeFloat(holding.weight) ?? 0,
		}))
		.filter(
			(holding) =>
				holding.ticker &&
				holding.weight >= ETF_PROXY_MIN_HOLDING_WEIGHT &&
				isStockLikeEtfRepresentativeTicker(holding.ticker),
		);
}

function etfProxyHoldingTickers(resolution: EtfResolutionResult): string[] {
	return uniqueTickers(
		resolution.etfPositions.flatMap((position) =>
			etfProxyHoldingsForTicker(resolution, String(position.ticker)).map(
				(holding) => holding.ticker,
			),
		),
	);
}

function etfProxyAggregationFor(field: string): EtfProxyAggregation {
	if (ETF_PROXY_HARMONIC_MEAN_FIELDS.has(field)) {
		return "harmonic_mean";
	}
	if (ETF_PROXY_INTERPOLATED_VALUE_FIELDS.has(field)) {
		return "coverage_mean";
	}
	return "weighted_mean";
}

function isUsableEtfProxyValue(field: string, value: number): boolean {
	if (ETF_PROXY_ZERO_IS_MISSING_FIELDS.has(field) && value === 0) {
		return false;
	}
	return !(ETF_PROXY_HARMONIC_MEAN_FIELDS.has(field) && value <= 0);
}

function hasUsableEtfProxyStats(indicators: Record<string, unknown>): boolean {
	return ETF_PROXY_STAT_FIELDS.some((field) => {
		const value = asNumber(indicators[field]);
		return value != null && isUsableEtfProxyValue(field, value);
	});
}

function hasFreshEtfProxyStats(
	stockEntry: StockEntry | undefined,
	now: number,
): boolean {
	const indicators = stockEntry?.indicators;
	if (!indicators || !hasUsableEtfProxyStats(indicators)) {
		return false;
	}
	return ETF_PROXY_TIMESTAMP_FIELDS.every((field) => {
		const timestamp = parseCacheTimestamp(indicators[field]);
		return timestamp != null && timestamp >= now - ETF_PROXY_CACHE_MAX_AGE_MS;
	});
}

async function resolveEtfProxyStocks({
	store,
	resolution,
	knownStocks,
	scope,
	normalRefreshTickers,
}: {
	store: BackendStore;
	resolution: EtfResolutionResult;
	knownStocks: Record<string, StockEntry>;
	scope: PortfolioScope;
	normalRefreshTickers: Set<string>;
}): Promise<{
	stocks: Record<string, StockEntry>;
	liveResults: Record<string, StatsResolutionResult>;
}> {
	const tickers = etfProxyHoldingTickers(resolution);
	if (tickers.length === 0) {
		return { stocks: {}, liveResults: {} };
	}

	const missingTickers = tickers.filter((ticker) => !knownStocks[ticker]);
	const cachedStocks =
		missingTickers.length > 0
			? await store.loadStocksByTickers(missingTickers)
			: {};
	const stockEntries = {
		...cachedStocks,
		...knownStocks,
	};
	if (!LIVE_SCOPES.has(scope)) {
		return {
			stocks: Object.fromEntries(
				tickers
					.map((ticker) => [ticker, stockEntries[ticker]] as const)
					.filter(([, stock]) => stock !== undefined),
			),
			liveResults: {},
		};
	}

	const now = Date.now();
	const refreshTickers = uniqueTickers(
		tickers.filter(
			(ticker) =>
				normalRefreshTickers.has(ticker) ||
				!hasFreshEtfProxyStats(stockEntries[ticker], now),
		),
	);
	const liveResults =
		refreshTickers.length > 0
			? await resolveTickerStatsMap(store, refreshTickers, "auto", stockEntries)
			: {};
	return {
		stocks: mergeLiveResultsIntoStocks(stockEntries, liveResults),
		liveResults,
	};
}

function shouldProxyEtfField(
	indicators: Record<string, unknown>,
	field: string,
	previouslyProxiedFields: Set<string>,
): boolean {
	if (field === "fx") {
		return false;
	}
	if (previouslyProxiedFields.has(field)) {
		return true;
	}
	if (
		ETF_PROXY_ZERO_IS_MISSING_FIELDS.has(field) &&
		asNumber(indicators[field]) === 0
	) {
		return true;
	}
	return asNumber(indicators[field]) == null;
}

function roundProxyValue(value: number): number {
	if (Math.abs(value) >= 1_000_000) {
		return Math.round(value);
	}
	return Number(value.toFixed(4));
}

function calculateEtfProxyValue(
	holdings: Array<{ ticker: string; weight: number }>,
	proxyStocks: Record<string, StockEntry>,
	field: string,
): { value: number; coverage: number } | null {
	let weightedSum = 0;
	let reciprocalWeightedSum = 0;
	let availableWeight = 0;

	for (const holding of holdings) {
		const value = asNumber(proxyStocks[holding.ticker]?.indicators[field]);
		if (value == null) {
			continue;
		}
		if (!isUsableEtfProxyValue(field, value)) {
			continue;
		}
		weightedSum += holding.weight * value;
		reciprocalWeightedSum += holding.weight / value;
		availableWeight += holding.weight;
	}

	if (availableWeight <= 0) {
		return null;
	}

	const aggregation = etfProxyAggregationFor(field);
	const value =
		aggregation === "harmonic_mean" && reciprocalWeightedSum > 0
			? availableWeight / reciprocalWeightedSum
			: weightedSum / availableWeight;
	return {
		value: roundProxyValue(value),
		coverage: Number(availableWeight.toFixed(4)),
	};
}

function applyEtfProxyStatsToStocks(
	stocksMap: Record<string, StockEntry>,
	resolution: EtfResolutionResult,
	proxyStocks: Record<string, StockEntry>,
): Record<string, StockEntry> {
	const output: Record<string, StockEntry> = {};
	for (const [ticker, stock] of Object.entries(stocksMap)) {
		output[ticker] = {
			indicators: { ...(stock.indicators ?? {}) },
			evaluation: { ...(stock.evaluation ?? {}) },
			labels: [...(stock.labels ?? [])],
		};
	}

	for (const position of resolution.etfPositions) {
		const etfTicker = normalizeTicker(position.ticker);
		const stock = output[etfTicker];
		if (!stock) {
			continue;
		}

		const indicators = { ...stock.indicators };
		const previouslyProxiedFields = new Set(
			Array.isArray(indicators.proxied_stat_fields)
				? indicators.proxied_stat_fields.map((field) => String(field))
				: [],
		);
		delete indicators.proxied_stat_fields;
		delete indicators.proxied_stat_coverage;
		delete indicators.stats_proxy_source;

		const holdings = etfProxyHoldingsForTicker(resolution, etfTicker);
		const proxiedFields: string[] = [];
		const proxiedCoverage: Record<string, number> = {};

		for (const field of ETF_PROXY_STAT_FIELDS) {
			if (!shouldProxyEtfField(indicators, field, previouslyProxiedFields)) {
				continue;
			}
			const proxy = calculateEtfProxyValue(holdings, proxyStocks, field);
			if (!proxy) {
				continue;
			}
			indicators[field] = proxy.value;
			proxiedFields.push(field);
			proxiedCoverage[field] = proxy.coverage;
		}

		if (proxiedFields.length > 0) {
			indicators.proxied_stat_fields = proxiedFields;
			indicators.proxied_stat_coverage = proxiedCoverage;
			indicators.stats_proxy_source = "etf_top_holdings";
		}

		output[etfTicker] = {
			...stock,
			indicators,
		};
	}

	return output;
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
				: typeof metadata.industry_name === "string" &&
						metadata.industry_name.trim()
					? metadata.industry_name
					: null,
		),
	];
}

async function buildEtfTables(
	rows: Array<Record<string, unknown>>,
	resolution: EtfResolutionResult,
	targetTickers: string[],
	notionalByTicker: Record<string, Notional>,
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
	const exposureTickers = new Set(targetTickers);
	for (const etfTicker of etfTickers) {
		const snapshot = resolution.snapshotByTicker[etfTicker];
		for (const holding of snapshot?.holdings ?? []) {
			const holdingTicker = normalizeTicker(holding.ticker);
			if (holdingTicker && isStockLikeEtfRepresentativeTicker(holdingTicker)) {
				exposureTickers.add(holdingTicker);
			}
		}
	}
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
		[...exposureTickers].map((ticker) => [
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
			if (!holdingTicker || !tickerExposure[holdingTicker]) {
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
		data.etf_lookthrough_weight = Number(
			data.etf_lookthrough_weight.toFixed(4),
		);
		data.combined_weight = normalizedCombinedWeights[ticker] ?? 0;
	}

	const stockSectorExposure: Record<string, number> = {};
	const stockSectorResults = await Promise.all(
		[...new Set(stockTickers)].map((ticker) =>
			fetchEquitySector(ticker, rowByTicker),
		),
	);
	for (const [ticker, sector] of stockSectorResults) {
		const directWeight = normalizedDirectWeights[ticker] ?? 0;
		stockSectorExposure[sector] =
			(stockSectorExposure[sector] ?? 0) + directWeight;
	}

	const tickerTable = Object.entries(tickerExposure)
		.map(([ticker, data]) => ({
			ticker,
			direct_weight: Number(data.direct_weight.toFixed(4)),
			etf_lookthrough_weight: Number(data.etf_lookthrough_weight.toFixed(4)),
			combined_weight: Number(data.combined_weight.toFixed(4)),
			notional: notionalByTicker[ticker] ?? new Notional(),
		}))
		.sort((left, right) => right.combined_weight - left.combined_weight);

	const combinedSectorExposure = { ...etfSectorExposure };
	for (const [sector, weight] of Object.entries(stockSectorExposure)) {
		combinedSectorExposure[sector] =
			(combinedSectorExposure[sector] ?? 0) + weight;
	}
	const etfSleeveTotal = Object.values(etfSectorExposure).reduce(
		(sum, value) => sum + value,
		0,
	);
	const sectorTable = Object.entries(combinedSectorExposure)
		.map(([sector, weight]) => ({
			sector,
			stock_weight: Number((stockSectorExposure[sector] ?? 0).toFixed(4)),
			etf_lookthrough_weight: Number(
				(etfSectorExposure[sector] ?? 0).toFixed(4),
			),
			portfolio_weight: Number(weight.toFixed(4)),
			within_etf_sleeve_weight:
				etfSleeveTotal > 0
					? Number(
							(
								((etfSectorExposure[sector] ?? 0) / etfSleeveTotal) *
								100
							).toFixed(4),
						)
					: 0,
		}))
		.sort((left, right) => right.portfolio_weight - left.portfolio_weight);

	return {
		tickerTable,
		sectorTable,
		meta: {
			direct_weight_total: Number(
				tickerTable
					.reduce((sum, row) => sum + Number(row.direct_weight), 0)
					.toFixed(4),
			),
			combined_weight_total: Number(
				tickerTable
					.reduce((sum, row) => sum + Number(row.combined_weight), 0)
					.toFixed(4),
			),
			sector_portfolio_total: Number(
				sectorTable
					.reduce((sum, row) => sum + Number(row.portfolio_weight), 0)
					.toFixed(4),
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
				(
					(directExposure.get(sector) ?? 0) + (etfExposure.get(sector) ?? 0)
				).toFixed(4),
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
		changeValue +=
			((changePercent / 100) * totalValue) / (1 + changePercent / 100);
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

function fxRefreshTickersForScope(
	positions: PositionRow[],
	stocksMap: Record<string, StockEntry>,
	scope: PortfolioScope,
): string[] {
	if (!LIVE_SCOPES.has(scope)) {
		return [];
	}
	return uniqueTickers(
		positions
			.filter((position) => {
				const ticker = normalizeTicker(position.ticker);
				const indicators = stocksMap[ticker]?.indicators ?? {};
				return (
					isNonUsTicker(ticker) &&
					asNumber(indicators.market_cap) != null &&
					asNumber(indicators.fx) == null
				);
			})
			.map((position) => position.ticker),
	);
}

/** Return the cache policy used for one portfolio scope. */
export function cacheControlForScope(scope: PortfolioScope): string {
	return scope === "all_cached"
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
	const normalizedEvaluation = deriveEvaluationScores(evaluation, indicators);
	const selectedEvaluation: Record<string, number | null> = {};
	let llmCount = 0;
	let selectedCount = 0;
	for (const field of EVAL_KEYS) {
		const [value, isFromLlm] = pickEvalValue({
			evaluation,
			normalizedEvaluation,
			key: field,
		});
		selectedEvaluation[field] = value;
		if (value != null) {
			selectedCount += 1;
		}
		if (isFromLlm) {
			llmCount += 1;
		}
	}
	const evalSource =
		selectedCount === 0
			? "none"
			: llmCount === selectedCount
				? "llm"
				: llmCount === 0
					? "stats"
					: "hybrid";
	const industryLabels = mergeIndicatorLabels(
		position,
		indicators,
		stockEntry?.labels ?? [],
	);
	const quoteType = String(indicators.quote_type ?? "")
		.trim()
		.toUpperCase();
	const etfHoldings = Array.isArray(indicators.etf_holdings)
		? indicators.etf_holdings
		: Array.isArray(indicators.holdings)
			? indicators.holdings
			: [];
	const strategyEvaluation =
		selectedCount > 0 || hasOwnEvaluation(evaluation)
			? selectedEvaluation
			: evaluation;
	const strategy = resolveRowStrategy(ticker, indicators, strategyEvaluation);

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
		equity_type: quoteType === "ETF" ? "ETF" : quoteType ? "STOCK" : "UNKNOWN",
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
	const scopedPositions = buildRowsForScope(
		portfolio.positions,
		stocksMap,
		scope,
	);
	const labelsByTicker = await resolvePortfolioLabels(
		store,
		portfolio.positions,
		stocksMap,
		LABEL_REFRESH_SCOPES.has(scope),
	);
	applyPositionLabels(scopedPositions, labelsByTicker);
	const evalTickers = new Set(
		Object.entries(stocksMap)
			.filter(([, stock]) => hasOwnEvaluation(stock.evaluation))
			.map(([ticker]) => ticker),
	);
	const liveTickers = liveTickersForScope(scopedPositions, evalTickers, scope);
	const fxRefreshTickers = fxRefreshTickersForScope(
		scopedPositions,
		stocksMap,
		scope,
	);
	const [liveResults, fxRefreshResults] = await Promise.all([
		liveTickers.length > 0
			? resolveTickerStatsMap(store, liveTickers, "auto", stocksMap)
			: Promise.resolve({}),
		fxRefreshTickers.length > 0
			? resolveTickerStatsMap(store, fxRefreshTickers, "live", stocksMap)
			: Promise.resolve({}),
	]);
	const resolvedLiveResults = {
		...liveResults,
		...fxRefreshResults,
	};
	const mergedStocks = mergeLiveResultsIntoStocks(
		stocksMap,
		resolvedLiveResults,
	);
	const etfResolution = await classifyAndResolveEtfs(
		store,
		portfolio.positions,
		mergedStocks,
		LIVE_SCOPES.has(scope),
	);
	const proxyEtfResolution = etfProxyResolutionForRows(
		etfResolution,
		scopedPositions,
		mergedStocks,
	);
	const preliminaryRows = scopedPositions.map((position) =>
		mergePortfolioRow(position, mergedStocks[normalizeTicker(position.ticker)]),
	);
	applyRowWeights(preliminaryRows);
	const etfRepresentativePositions = buildEtfRepresentativePositions(
		etfResolution,
		new Set(
			preliminaryRows.map((row) => normalizeTicker(row.ticker)).filter(Boolean),
		),
		weightPctByTicker(preliminaryRows),
	);
	const etfRepresentativeTickers = etfRepresentativePositions.map(
		(position) => position.ticker,
	);
	const proxyStockResolution = await resolveEtfProxyStocks({
		store,
		resolution: proxyEtfResolution,
		knownStocks: mergedStocks,
		scope,
		normalRefreshTickers: new Set(
			uniqueTickers([...liveTickers, ...etfRepresentativeTickers]),
		),
	});
	const proxiedStocks = applyEtfProxyStatsToStocks(
		mergedStocks,
		proxyEtfResolution,
		proxyStockResolution.stocks,
	);

	const rows = scopedPositions.map((position) =>
		mergePortfolioRow(
			position,
			proxiedStocks[normalizeTicker(position.ticker)],
		),
	);
	const heldTotal = applyRowWeights(rows);

	for (const row of rows) {
		const ticker = normalizeTicker(row.ticker);
		const snapshot = etfResolution.snapshotByTicker[ticker];
		if (!snapshot) {
			continue;
		}
		row.equity_type = "ETF";
		clearEtfMarketCapFields(row);
		row.etf_holdings = snapshot.holdings;
		row.etf_sectors = snapshot.sectors;
		row.etf_holdings_fetched_at =
			typeof proxiedStocks[ticker]?.indicators.etf_holdings_fetched_at ===
			"string"
				? proxiedStocks[ticker]?.indicators.etf_holdings_fetched_at
				: nowIso();
	}
	for (const position of etfRepresentativePositions) {
		const ticker = normalizeTicker(position.ticker);
		const cachedStock =
			proxyStockResolution.stocks[ticker] ?? proxiedStocks[ticker];
		const row = mergePortfolioRow(position, cachedStock);
		row.etf_lookthrough_only = true;
		row.weight_pct = 0;
		row.etf_holding_weight = position.etf_holding_weight;
		row.etf_holding_notional_weight = position.etf_holding_notional_weight;
		row.etf_source_tickers = position.etf_source_tickers;
		if (row.equity_type === "UNKNOWN") {
			row.equity_type = "STOCK";
		}
		rows.push(row);
	}
	const notionalByTicker = buildNotionalByTicker(rows, etfResolution);
	for (const row of rows) {
		const ticker = normalizeTicker(row.ticker);
		const rowNotional = notionalByTicker[ticker] ?? new Notional();
		row.notional = rowNotional;
		row.notional_value = rowNotional.total;
		row.notional_weight_pct =
			heldTotal > 0 && rowNotional.total > 0
				? (rowNotional.total / heldTotal) * 100
				: 0;
	}

	rankRows(rows);
	rows.sort(
		(left, right) =>
			Number(right.weight_pct ?? 0) - Number(left.weight_pct ?? 0),
	);
	const heldTickers = portfolio.positions
		.map((position) => normalizeTicker(position.ticker))
		.filter(Boolean);
	const sectorDistribution = buildSectorDistribution(rows, etfResolution);
	const [{ tickerTable, sectorTable, meta: tableMeta }, generatedAt] =
		await Promise.all([
			buildEtfTables(rows, etfResolution, heldTickers, notionalByTicker),
			LIVE_SCOPES.has(scope)
				? Promise.resolve(nowIso())
				: store.getMetaValue("stats_generated_at"),
		]);
	const allLiveResults = {
		...resolvedLiveResults,
		...proxyStockResolution.liveResults,
	};
	let dataSource = LIVE_SCOPES.has(scope)
		? aggregateTickerDataSource(allLiveResults, "auto")
		: "cache";
	if (LIVE_SCOPES.has(scope) && dataSource === "live") {
		const liveTickerSet = new Set(Object.keys(allLiveResults));
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
			sync_mode: "realtime_subscription",
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
	if (
		index < 0 &&
		patch.quantity === undefined &&
		patch.strategy === undefined
	) {
		throw new Error("Patch payload is empty.");
	}
	const current =
		index >= 0
			? { ...positions[index] }
			: ({ ticker: tickerSymbol } as PositionRow);
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
	await savePortfolioPositionsAndForgetRemoved(
		store,
		positions,
		previousTickers,
	);
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
		Object.entries(stocks).map(([ticker, stock]) => [
			ticker,
			deriveEvaluationScores(stock.evaluation, stock.indicators),
		]),
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
