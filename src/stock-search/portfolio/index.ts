/** Build portfolio payloads with cache-aware live refresh and ETF lookthrough. */

import { classifyAndResolveEtfs } from "../etf/index.js";
import { deriveEvaluationScores } from "../evaluation/normalization.js";
import { policy, type PortfolioScope } from "../policy.js";
import { aggregateTickerDataSource, resolveTickerStatsMap } from "../stats-resolver/index.js";
import type { BackendStore, StockEntry } from "../storage/index.js";
import {
  PORTFOLIO_STATS_GENERATED_AT_META_KEY,
  portfolioScopedMetaKey,
} from "../storage/portfolio-keys.js";
import { normalizeTicker, nowIso } from "../utils.js";
import { buildPortfolioExposureTables } from "./exposure.js";
import { applyPositionLabels, resolvePortfolioLabels } from "./labels.js";
import { buildPortfolioEnrichedRows } from "./row-enrichment.js";
import {
  buildRowsForUniverse,
  calculatePortfolioStats,
  fxRefreshTickersForLivePolicy,
  hasOwnEvaluation,
  liveTickersForRefreshIntent,
  mergeLiveResultsIntoStocks,
} from "./rows.js";
import { portfolioTickers } from "./shared.js";

export type { PortfolioScope } from "../policy.js";
export { patchPortfolioPosition, removePortfolioPosition } from "./positions.js";
export { mergePortfolioRow } from "./rows.js";

const STATS_GENERATED_AT_META_KEY = "stats_generated_at";
const STORED_PORTFOLIO_STATS_SYNC_MODE = "stored_portfolio_stats";

/** Build the public portfolio payload for one scope. */
export async function buildPortfolioPayload(
  store: BackendStore,
  scope: PortfolioScope,
  portfolioKey?: string,
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
  const portfolio = await store.loadPortfolio(portfolioKey);
  const heldTickers = portfolioTickers(portfolio.positions);
  const stockEntriesByTicker =
    scopePolicy.universe === "all_stored"
      ? await store.loadStocks()
      : await store.loadStocksByTickers(heldTickers);
  const scopedPositions = buildRowsForUniverse(
    portfolio.positions,
    stockEntriesByTicker,
    scopePolicy.universe === "all_stored",
  );
  const labelsByTicker = await resolvePortfolioLabels(
    store,
    portfolio.positions,
    stockEntriesByTicker,
    scopePolicy.refreshLabels,
  );
  applyPositionLabels(scopedPositions, labelsByTicker);
  const tickersWithOwnEvaluation = new Set(
    Object.entries(stockEntriesByTicker)
      .filter(([, stock]) => hasOwnEvaluation(stock.evaluation))
      .map(([ticker]) => ticker),
  );
  const normalRefreshTickers = liveTickersForRefreshIntent(
    scopedPositions,
    tickersWithOwnEvaluation,
    scopePolicy.refreshIntent,
    stockEntriesByTicker,
  );
  const fxRefreshTickers = fxRefreshTickersForLivePolicy(
    scopedPositions,
    stockEntriesByTicker,
    scopePolicy.liveRefresh,
  );
  const [liveResults, fxRefreshResults] = await Promise.all([
    normalRefreshTickers.length > 0
      ? resolveTickerStatsMap(
          store,
          normalRefreshTickers,
          scopePolicy.statsMode,
          stockEntriesByTicker,
        )
      : Promise.resolve({}),
    fxRefreshTickers.length > 0
      ? resolveTickerStatsMap(store, fxRefreshTickers, "live", stockEntriesByTicker)
      : Promise.resolve({}),
  ]);
  const liveResultsByTicker = {
    ...liveResults,
    ...fxRefreshResults,
  };
  const mergedStocks = mergeLiveResultsIntoStocks(stockEntriesByTicker, liveResultsByTicker);
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
    normalRefreshTickers,
  });
  const rows = rowResolution.rows;
  const notionalByTicker = rowResolution.notionalByTicker;
  const [{ tickerTable, sectorTable, meta: tableMeta }, generatedAt] = await Promise.all([
    buildPortfolioExposureTables(rows, etfResolution, heldTickers, notionalByTicker),
    scopePolicy.liveRefresh
      ? Promise.resolve(nowIso())
      : store.getMetaValue(STATS_GENERATED_AT_META_KEY),
  ]);
  const refreshedResultsByTicker = {
    ...liveResultsByTicker,
    ...rowResolution.proxyLiveResults,
  };
  let dataSource = scopePolicy.liveRefresh
    ? aggregateTickerDataSource(refreshedResultsByTicker, "auto")
    : "cache";
  if (scopePolicy.liveRefresh && dataSource === "live") {
    const refreshedTickerSet = new Set(Object.keys(refreshedResultsByTicker));
    for (const row of rows) {
      const ticker = normalizeTicker(row.ticker);
      if (ticker && !refreshedTickerSet.has(ticker)) {
        dataSource = "live_with_cache_fallback";
        break;
      }
    }
  }
  const portfolioStats = calculatePortfolioStats(rows, sectorTable);
  if (scopePolicy.persistPortfolioStats) {
    await Promise.all([
      store.savePortfolioStats(portfolioStats, portfolioKey),
      store.setMetaValue(
        portfolioScopedMetaKey(PORTFOLIO_STATS_GENERATED_AT_META_KEY, portfolioKey),
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
  portfolioKey?: string,
): Promise<{
  portfolio_stats: Record<string, unknown> | null;
  meta: Record<string, unknown>;
}> {
  const [portfolio, generatedAt] = await Promise.all([
    store.loadPortfolio(portfolioKey),
    store
      .getMetaValue(portfolioScopedMetaKey(PORTFOLIO_STATS_GENERATED_AT_META_KEY, portfolioKey))
      .then((value) => value ?? store.getMetaValue(STATS_GENERATED_AT_META_KEY)),
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
  return tickers && tickers.length > 0 ? store.loadStocksByTickers(tickers) : store.loadStocks();
}
