/** Build portfolio payloads with cache-aware live refresh and ETF lookthrough. */

import type {
	BackendStore,
	PositionRow,
	StockEntry,
} from "../api/data-store.js";
import { classifyAndResolveEtfs } from "../etf.js";
import { deriveEvaluationScores } from "../evaluation/normalization.js";
import { Notional } from "../models/schemas.js";
import {
	aggregateTickerDataSource,
	resolveTickerStatsMap,
} from "../stats-resolver.js";
import { normalizeTicker, nowIso, uniqueTickers } from "../utils.js";
import {
	applyEtfProxyStatsToStocks,
	buildEtfRepresentativePositions,
	etfProxyResolutionForRows,
	resolveEtfProxyStocks,
} from "./etf-proxy.js";
import {
	buildEtfTables,
	buildNotionalByTicker,
	buildSectorDistribution,
} from "./exposure.js";
import { applyPositionLabels, resolvePortfolioLabels } from "./labels.js";
import {
	applyRowWeights,
	buildRowsForScope,
	calculatePortfolioStats,
	clearEtfMarketCapFields,
	fxRefreshTickersForScope,
	hasOwnEvaluation,
	liveTickersForScope,
	mergeLiveResultsIntoStocks,
	mergePortfolioRow,
	rankRows,
	weightPctByTicker,
} from "./rows.js";
import {
	ALL_UNIVERSE_SCOPES,
	LABEL_REFRESH_SCOPES,
	LIVE_SCOPES,
	type PortfolioScope,
	portfolioTickers,
} from "./shared.js";

export {
	patchPortfolioPosition,
	removePortfolioPosition,
} from "./positions.js";
export { mergePortfolioRow } from "./rows.js";
export type { PortfolioScope } from "./shared.js";

/** Return the cache policy used for one portfolio scope. */
export function cacheControlForScope(scope: PortfolioScope): string {
	return scope === "all_cached"
		? "private, max-age=30, stale-while-revalidate=300"
		: "no-store";
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
