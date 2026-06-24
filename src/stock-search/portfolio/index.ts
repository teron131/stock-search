/** Build portfolio payloads with cache-aware live refresh and ETF lookthrough. */

import { classifyAndResolveEtfs } from "../etf/index.js";
import { deriveEvaluationScores } from "../evaluation/normalization.js";
import { type PortfolioScope, policy } from "../policy.js";
import {
	aggregateTickerDataSource,
	resolveTickerStatsMap,
} from "../stats-resolver/index.js";
import type {
	BackendStore,
	PositionRow,
	StockEntry,
} from "../storage/index.js";
import { normalizeTicker, nowIso } from "../utils.js";
import { buildEtfTables, buildSectorDistribution } from "./exposure.js";
import { applyPositionLabels, resolvePortfolioLabels } from "./labels.js";
import { buildPortfolioEnrichedRows } from "./row-enrichment.js";
import {
	buildRowsForUniverse,
	calculatePortfolioStats,
	fxRefreshTickersForLivePolicy,
	hasOwnEvaluation,
	liveTickersForRefreshIntent,
	mergeLiveResultsIntoStocks,
	mergePortfolioRow,
} from "./rows.js";
import { portfolioTickers } from "./shared.js";

export {
	patchPortfolioPosition,
	removePortfolioPosition,
} from "./positions.js";
export { mergePortfolioRow } from "./rows.js";
export type { PortfolioScope } from "./shared.js";

const PORTFOLIO_STATS_GENERATED_AT_META_KEY = "portfolio_stats_generated_at";
const STATS_GENERATED_AT_META_KEY = "stats_generated_at";
const STORED_PORTFOLIO_STATS_SYNC_MODE = "stored_portfolio_stats";

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
	const scopePolicy = policy.request.portfolioScope(scope);
	const portfolio = await store.loadPortfolio();
	const stocksMap =
		scopePolicy.universe === "all_stored"
			? await store.loadStocks()
			: await store.loadStocksByTickers(portfolioTickers(portfolio.positions));
	const scopedPositions = buildRowsForUniverse(
		portfolio.positions,
		stocksMap,
		scopePolicy.universe === "all_stored",
	);
	const labelsByTicker = await resolvePortfolioLabels(
		store,
		portfolio.positions,
		stocksMap,
		scopePolicy.refreshLabels,
	);
	applyPositionLabels(scopedPositions, labelsByTicker);
	const evalTickers = new Set(
		Object.entries(stocksMap)
			.filter(([, stock]) => hasOwnEvaluation(stock.evaluation))
			.map(([ticker]) => ticker),
	);
	const liveTickers = liveTickersForRefreshIntent(
		scopedPositions,
		evalTickers,
		scopePolicy.refreshIntent,
		stocksMap,
	);
	const fxRefreshTickers = fxRefreshTickersForLivePolicy(
		scopedPositions,
		stocksMap,
		scopePolicy.liveRefresh,
	);
	const [liveResults, fxRefreshResults] = await Promise.all([
		liveTickers.length > 0
			? resolveTickerStatsMap(
					store,
					liveTickers,
					scopePolicy.statsMode,
					stocksMap,
				)
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
		scopePolicy.liveRefresh,
	);
	const rowResolution = await buildPortfolioEnrichedRows({
		store,
		positions: scopedPositions,
		stocksMap: mergedStocks,
		etfResolution,
		liveRefresh: scopePolicy.liveRefresh,
		normalRefreshTickers: liveTickers,
	});
	const rows = rowResolution.rows;
	const notionalByTicker = rowResolution.notionalByTicker;
	const heldTickers = portfolio.positions
		.map((position) => normalizeTicker(position.ticker))
		.filter(Boolean);
	const sectorDistribution = buildSectorDistribution(rows, etfResolution);
	const [{ tickerTable, sectorTable, meta: tableMeta }, generatedAt] =
		await Promise.all([
			buildEtfTables(rows, etfResolution, heldTickers, notionalByTicker),
			scopePolicy.liveRefresh
				? Promise.resolve(nowIso())
				: store.getMetaValue(STATS_GENERATED_AT_META_KEY),
		]);
	const allLiveResults = {
		...resolvedLiveResults,
		...rowResolution.proxyLiveResults,
	};
	let dataSource = scopePolicy.liveRefresh
		? aggregateTickerDataSource(allLiveResults, "auto")
		: "cache";
	if (scopePolicy.liveRefresh && dataSource === "live") {
		const liveTickerSet = new Set(Object.keys(allLiveResults));
		for (const row of rows) {
			const ticker = normalizeTicker(row.ticker);
			if (ticker && !liveTickerSet.has(ticker)) {
				dataSource = "live_with_cache_fallback";
				break;
			}
		}
	}
	const portfolioStats = calculatePortfolioStats(rows, sectorDistribution);
	if (scopePolicy.persistPortfolioStats) {
		await Promise.all([
			store.savePortfolioStats(portfolioStats),
			store.setMetaValue(
				PORTFOLIO_STATS_GENERATED_AT_META_KEY,
				generatedAt ?? nowIso(),
			),
		]);
	}

	return {
		rows,
		tables: {
			ticker_exposure: tickerTable,
			sector_exposure: sectorTable,
		},
		portfolio_stats: portfolioStats,
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

/** Read stored portfolio stats without refreshing portfolio rows. */
export async function readStoredPortfolioStatsPayload(
	store: BackendStore,
): Promise<{
	portfolio_stats: Record<string, unknown> | null;
	meta: Record<string, unknown>;
}> {
	const [portfolio, generatedAt] = await Promise.all([
		store.loadPortfolio(),
		store
			.getMetaValue(PORTFOLIO_STATS_GENERATED_AT_META_KEY)
			.then(
				(value) => value ?? store.getMetaValue(STATS_GENERATED_AT_META_KEY),
			),
	]);
	return {
		portfolio_stats: portfolio.portfolioStats,
		meta: {
			generated_at: generatedAt,
			data_source: "cache",
			backend_store: store.backendName,
			sync_mode: STORED_PORTFOLIO_STATS_SYNC_MODE,
		},
	};
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
