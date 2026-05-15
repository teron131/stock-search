/** Resolve ETF lookthrough representatives and proxy ETF stats from holdings. */

import type {
	BackendStore,
	PositionRow,
	StockEntry,
} from "../api/data-store.js";
import { parseCacheTimestamp } from "../cache.js";
import type { EtfResolutionResult } from "../etf/index.js";
import {
	resolveTickerStatsMap,
	type StatsResolutionResult,
} from "../stats-resolver/index.js";
import { asNumber, normalizeTicker, uniqueTickers } from "../utils.js";
import { mergeLiveResultsIntoStocks } from "./rows.js";
import { LIVE_SCOPES, type PortfolioScope } from "./shared.js";

type EtfRepresentativePosition = PositionRow & {
	etf_holding_weight: number;
	etf_holding_notional_weight: number;
	etf_source_tickers: string[];
};

type EtfProxyAggregation = "coverage_mean" | "harmonic_mean" | "weighted_mean";

const ETF_LOOKTHROUGH_ROW_MIN_WEIGHT = 2;
const ETF_LOOKTHROUGH_ROW_MIN_NOTIONAL_WEIGHT = 0.5;
const ETF_PROXY_MIN_HOLDING_WEIGHT = 0.5;
const ETF_PROXY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ETF_PROXY_TIMESTAMP_FIELDS = [
	"statistics_fetched_at",
	"financials_fetched_at",
] as const;
const NON_STOCK_ETF_HOLDING_SUFFIXES = new Set(["TRS"]);
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
	"change_percent_1m",
	"change_percent_3m",
	"change_percent_6m",
	"change_percent_1y",
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
	"operating_margin_delta_vs_3y",
	"operating_margin_std_3y",
	"roe",
	"roic",
	"debt_to_equity",
	"free_cash_flow",
	"fcf_margin_median_3y",
	"shares_change_1y",
	"shares_change_cagr_3y",
	"shareholder_yield",
	"research_and_development",
	"rd_intensity",
	"rd_knowledge_capital",
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
	"research_and_development",
	"rd_knowledge_capital",
]);
const ETF_PROXY_ZERO_IS_MISSING_FIELDS = new Set<string>(["beta"]);

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
					const weight = Number(row.weight);
					if (!ticker || !Number.isFinite(weight)) {
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
					const weight = Number(row.weight);
					return name && Number.isFinite(weight) ? { name, weight } : null;
				})
				.filter((sector) => sector != null)
		: [];
	return { holdings, sectors, error: null };
}

export function etfProxyResolutionForRows(
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

export function isStockLikeEtfRepresentativeTicker(ticker: string): boolean {
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

export function buildEtfRepresentativePositions(
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
			const holdingWeight = Number(holding.weight) || 0;
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
			weight: Number(holding.weight) || 0,
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

export async function resolveEtfProxyStocks({
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

export function applyEtfProxyStatsToStocks(
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
