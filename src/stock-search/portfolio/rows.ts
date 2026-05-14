/** Build dashboard portfolio rows from positions, indicators, and evaluation data. */

import type { PositionRow, StockEntry } from "../api/data-store.js";
import {
	bucketFromEvaluation,
	deriveEvaluationScores,
} from "../evaluation/normalization.js";
import { asNumber, normalizeTicker } from "../utils.js";
import {
	ALL_UNIVERSE_SCOPES,
	EVAL_KEYS,
	normalizeLabels,
	PORTFOLIO_LABEL_FIELD,
	type PortfolioScope,
	STAT_DERIVED_EVAL_KEYS,
} from "./shared.js";

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

function positionQuantity(position: PositionRow): number {
	const quantity = Number(position.quantity ?? 0);
	return Number.isFinite(quantity) ? quantity : 0;
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

export function clearEtfMarketCapFields(row: Record<string, unknown>): void {
	const proxiedFields = Array.isArray(row.proxied_stat_fields)
		? row.proxied_stat_fields.map((field) => String(field))
		: [];
	if (!proxiedFields.includes("market_cap")) {
		row.market_cap = null;
	}
	row.fx = null;
}

export function hasOwnEvaluation(
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

export function buildRowsForScope(
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

export function rankRows(rows: Array<Record<string, unknown>>): void {
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

export function mergeLiveResultsIntoStocks(
	stocksMap: Record<string, StockEntry>,
	liveResults: Record<
		string,
		{
			row: Record<string, unknown>;
		}
	>,
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

export function applyRowWeights(rows: Array<Record<string, unknown>>): number {
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

export function weightPctByTicker(
	rows: Array<Record<string, unknown>>,
): Map<string, number> {
	return new Map(
		rows.map((row) => [
			normalizeTicker(row.ticker),
			asNumber(row.weight_pct) ?? 0,
		]),
	);
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

export function calculatePortfolioStats(
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

export function liveTickersForScope(
	positions: PositionRow[],
	evalTickers: Set<string>,
	scope: PortfolioScope,
): string[] {
	if (scope !== "portfolio_live" && scope !== "all") {
		return [];
	}
	return [
		...new Set(
			positions
				.filter((position) => {
					const ticker = normalizeTicker(position.ticker);
					return evalTickers.has(ticker) || positionQuantity(position) > 0;
				})
				.map((position) => normalizeTicker(position.ticker))
				.filter(Boolean),
		),
	];
}

export function fxRefreshTickersForScope(
	positions: PositionRow[],
	stocksMap: Record<string, StockEntry>,
	scope: PortfolioScope,
): string[] {
	if (scope !== "portfolio_live" && scope !== "all") {
		return [];
	}
	return [
		...new Set(
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
				.map((position) => normalizeTicker(position.ticker))
				.filter(Boolean),
		),
	];
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
