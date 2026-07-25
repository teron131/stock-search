/** Build ETF-aware portfolio rows with proxy statistics and notional exposure. */

import { safeFloat } from "../common-utils.js";
import { ETF_HOLDINGS_FETCHED_AT_FIELD, type EtfResolutionResult } from "../etf/index.js";
import { Notional } from "../models/schemas.js";
import type { StatsResolutionResult } from "../stats-resolver/index.js";
import type { BackendStore, PositionRow, StockEntry } from "../storage/index.js";
import { normalizeTicker, nowIso, uniqueTickers } from "../utils.js";
import {
  applyEtfProxyStatsToStocks,
  buildEtfRepresentativePositions,
  etfProxyResolutionForRows,
  isStockLikeEtfRepresentativeTicker,
  resolveEtfProxyStocks,
} from "./etf-proxy.js";
import {
  applyRowWeights,
  clearEtfMarketCapFields,
  mergePortfolioRow,
  rankRows,
  weightPctByTicker,
} from "./rows.js";

export type EnrichedPortfolioRows = {
  rows: Array<Record<string, unknown>>;
  notionalByTicker: Record<string, Notional>;
  proxyLiveResults: Record<string, StatsResolutionResult>;
};

/** Apply ETF snapshot metadata to rows that represent ETF positions. */
function applyEtfSnapshotFields(
  rows: Array<Record<string, unknown>>,
  etfResolution: EtfResolutionResult,
  proxiedStocks: Record<string, StockEntry>,
): void {
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
    const holdingsFetchedAt = proxiedStocks[ticker]?.indicators[ETF_HOLDINGS_FETCHED_AT_FIELD];
    if (typeof holdingsFetchedAt === "string") {
      row.etf_holdings_fetched_at = holdingsFetchedAt;
    } else if (snapshot.holdings.length > 0 || snapshot.sectors.length > 0) {
      row.etf_holdings_fetched_at = nowIso();
    } else {
      row.etf_holdings_fetched_at = null;
    }
  }
}

/** Append lookthrough-only rows for meaningful ETF representative holdings. */
function appendEtfRepresentativeRows({
  rows,
  positions,
  proxyStocks,
  proxiedStocks,
}: {
  rows: Array<Record<string, unknown>>;
  positions: PositionRow[];
  proxyStocks: Record<string, StockEntry>;
  proxiedStocks: Record<string, StockEntry>;
}): void {
  for (const position of positions) {
    const ticker = normalizeTicker(position.ticker);
    const cachedStock = proxyStocks[ticker] ?? proxiedStocks[ticker];
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
}

/** Attach direct and ETF-lookthrough notional values to every public row. */
function applyNotionalFields(
  rows: Array<Record<string, unknown>>,
  heldTotal: number,
  notionalByTicker: Record<string, Notional>,
): void {
  for (const row of rows) {
    const ticker = normalizeTicker(row.ticker);
    const rowNotional = notionalByTicker[ticker] ?? new Notional();
    row.notional = rowNotional;
    row.notional_value = rowNotional.total;
    row.notional_weight_pct =
      heldTotal > 0 && rowNotional.total > 0 ? (rowNotional.total / heldTotal) * 100 : 0;
  }
}

/** Build direct and ETF-lookthrough notional totals for enriched rows. */
function buildNotionalByTicker(
  rows: Array<Record<string, unknown>>,
  etfResolution: EtfResolutionResult,
): Record<string, Notional> {
  const notionalByTicker: Record<string, Notional> = {};
  const rowByTicker = new Map(rows.map((row) => [normalizeTicker(row.ticker), row] as const));

  for (const row of rows) {
    const ticker = normalizeTicker(row.ticker);
    const total = safeFloat(row.total) ?? 0;
    if (!ticker || total <= 0) {
      continue;
    }
    notionalByTicker[ticker] ??= new Notional();
    notionalByTicker[ticker].addFromStocks(total);
  }

  for (const etfPosition of etfResolution.etfPositions) {
    const etfTicker = normalizeTicker(etfPosition.ticker);
    const etfTotal = safeFloat(rowByTicker.get(etfTicker)?.total) ?? 0;
    const snapshot = etfResolution.snapshotByTicker[etfTicker];
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
      notionalByTicker[holdingTicker] ??= new Notional();
      notionalByTicker[holdingTicker].addFromEtf(etfTotal * (holding.weight / 100));
    }
  }

  return Object.fromEntries(
    Object.entries(notionalByTicker).map(([ticker, notional]) => [ticker, notional.rounded()]),
  );
}

/** Build portfolio rows after live stats are merged into stock entries. */
export async function buildPortfolioEnrichedRows({
  store,
  positions,
  stocksMap,
  etfResolution,
  liveRefresh,
  normalRefreshTickers,
}: {
  store: BackendStore;
  positions: PositionRow[];
  stocksMap: Record<string, StockEntry>;
  etfResolution: EtfResolutionResult;
  liveRefresh: boolean;
  normalRefreshTickers: string[];
}): Promise<EnrichedPortfolioRows> {
  const proxyEtfResolution = etfProxyResolutionForRows(etfResolution, positions, stocksMap);
  const preliminaryRows = positions.map((position) =>
    mergePortfolioRow(position, stocksMap[normalizeTicker(position.ticker)]),
  );
  applyRowWeights(preliminaryRows);
  const etfRepresentativePositions = buildEtfRepresentativePositions(
    etfResolution,
    new Set(preliminaryRows.map((row) => normalizeTicker(row.ticker)).filter(Boolean)),
    weightPctByTicker(preliminaryRows),
  );
  const etfRepresentativeTickers = etfRepresentativePositions.map((position) => position.ticker);
  const proxyStockResolution = await resolveEtfProxyStocks({
    store,
    resolution: proxyEtfResolution,
    knownStocks: stocksMap,
    liveRefresh,
    normalRefreshTickers: new Set(
      uniqueTickers([...normalRefreshTickers, ...etfRepresentativeTickers]),
    ),
  });
  const proxiedStocks = applyEtfProxyStatsToStocks(
    stocksMap,
    proxyEtfResolution,
    proxyStockResolution.stocks,
  );
  const rows = positions.map((position) =>
    mergePortfolioRow(position, proxiedStocks[normalizeTicker(position.ticker)]),
  );
  const heldTotal = applyRowWeights(rows);

  applyEtfSnapshotFields(rows, etfResolution, proxiedStocks);
  appendEtfRepresentativeRows({
    rows,
    positions: etfRepresentativePositions,
    proxyStocks: proxyStockResolution.stocks,
    proxiedStocks,
  });
  const notionalByTicker = buildNotionalByTicker(rows, etfResolution);
  applyNotionalFields(rows, heldTotal, notionalByTicker);
  rankRows(rows);
  rows.sort((left, right) => Number(right.weight_pct ?? 0) - Number(left.weight_pct ?? 0));

  return {
    rows,
    notionalByTicker,
    proxyLiveResults: proxyStockResolution.liveResults,
  };
}
