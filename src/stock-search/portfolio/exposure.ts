/** Build portfolio exposure tables with ETF lookthrough and notional detail. */

import { safeFloat } from "../common-utils.js";
import { YahooFinanceSource } from "../data-sources/yahoo-finance.js";
import type { EtfResolutionResult } from "../etf/index.js";
import { normalizeSectorName } from "../etf/index.js";
import { Notional } from "../models/schemas.js";
import { normalizeTicker } from "../utils.js";
import { isStockLikeEtfRepresentativeTicker } from "./etf-proxy.js";

type SectorExposureRow = {
  sector: string;
  portfolio_weight: number;
  stock_weight: number;
  etf_lookthrough_weight: number;
  within_etf_sleeve_weight: number;
};

type TickerExposureRow = {
  ticker: string;
  direct_weight: number;
  etf_lookthrough_weight: number;
  combined_weight: number;
  notional: Notional;
};

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
    (100 - Object.values(rounded).reduce((sum, value) => sum + value, 0)).toFixed(decimals),
  );
  if (adjustment === 0) {
    return rounded;
  }
  const largestTicker = Object.entries(rounded).sort((left, right) => right[1] - left[1])[0]?.[0];
  if (largestTicker) {
    rounded[largestTicker] = Number((rounded[largestTicker] + adjustment).toFixed(decimals));
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

  const metadata = await new YahooFinanceSource(ticker).getSymbolMetadataSnapshot();
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

export async function buildPortfolioExposureTables(
  rows: Array<Record<string, unknown>>,
  etfResolution: EtfResolutionResult,
  heldTickers: string[],
  notionalByTicker: Record<string, Notional>,
): Promise<{
  tickerTable: TickerExposureRow[];
  sectorTable: SectorExposureRow[];
  meta: Record<string, number>;
}> {
  const rowByTicker = new Map(rows.map((row) => [normalizeTicker(row.ticker), row] as const));
  const directStockTickers = etfResolution.stockPositions.map((position) =>
    normalizeTicker(position.ticker),
  );
  const etfTickers = etfResolution.etfPositions.map((position) => normalizeTicker(position.ticker));
  const exposureTickers = new Set(heldTickers);
  for (const etfTicker of etfTickers) {
    const snapshot = etfResolution.snapshotByTicker[etfTicker];
    for (const holding of snapshot?.holdings ?? []) {
      const holdingTicker = normalizeTicker(holding.ticker);
      if (holdingTicker && isStockLikeEtfRepresentativeTicker(holdingTicker)) {
        exposureTickers.add(holdingTicker);
      }
    }
  }
  const portfolioTotal = heldTickers.reduce((sum, ticker) => {
    return sum + (safeFloat(rowByTicker.get(ticker)?.total) ?? 0);
  }, 0);
  const directWeightsByTicker = Object.fromEntries(
    heldTickers.map((ticker) => {
      const total = safeFloat(rowByTicker.get(ticker)?.total) ?? 0;
      return [ticker, portfolioTotal > 0 ? (total / portfolioTotal) * 100 : 0];
    }),
  );
  const etfSleeveWeightsByTicker = Object.fromEntries(
    etfTickers.map((ticker) => {
      const total = safeFloat(rowByTicker.get(ticker)?.total) ?? 0;
      return [ticker, portfolioTotal > 0 ? (total / portfolioTotal) * 100 : 0];
    }),
  );
  const tickerWeightsByTicker = Object.fromEntries(
    [...exposureTickers].map((ticker) => [
      ticker,
      {
        direct_weight: directWeightsByTicker[ticker] ?? 0,
        etf_lookthrough_weight: 0,
        combined_weight: directWeightsByTicker[ticker] ?? 0,
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
  const distributedEtfLookthroughWeights = Object.fromEntries(
    etfTickers.map((ticker) => [ticker, 0]),
  ) as Record<string, number>;
  const etfSectorWeights: Record<string, number> = {};

  for (const etfTicker of etfTickers) {
    const snapshot = etfResolution.snapshotByTicker[etfTicker];
    if (!snapshot) {
      continue;
    }
    const etfWeight = etfSleeveWeightsByTicker[etfTicker] ?? 0;
    for (const holding of snapshot.holdings) {
      const holdingTicker = normalizeTicker(holding.ticker);
      if (!holdingTicker || !tickerWeightsByTicker[holdingTicker]) {
        continue;
      }
      const contribution = etfWeight * (holding.weight / 100);
      tickerWeightsByTicker[holdingTicker].etf_lookthrough_weight += contribution;
      tickerWeightsByTicker[holdingTicker].combined_weight += contribution;
      distributedEtfLookthroughWeights[etfTicker] =
        (distributedEtfLookthroughWeights[etfTicker] ?? 0) + contribution;
    }
    for (const sector of snapshot.sectors) {
      const contribution = etfWeight * (sector.weight / 100);
      etfSectorWeights[sector.name] = (etfSectorWeights[sector.name] ?? 0) + contribution;
    }
  }

  for (const etfTicker of etfTickers) {
    if (tickerWeightsByTicker[etfTicker]) {
      tickerWeightsByTicker[etfTicker].combined_weight -=
        distributedEtfLookthroughWeights[etfTicker] ?? 0;
    }
  }

  const normalizedDirectWeights = normalizeWeightsTo100(
    Object.fromEntries(
      Object.entries(tickerWeightsByTicker).map(([ticker, weights]) => [
        ticker,
        weights.direct_weight,
      ]),
    ),
  );
  const normalizedCombinedWeights = normalizeWeightsTo100(
    Object.fromEntries(
      Object.entries(tickerWeightsByTicker).map(([ticker, weights]) => [
        ticker,
        weights.combined_weight,
      ]),
    ),
  );
  for (const [ticker, weights] of Object.entries(tickerWeightsByTicker)) {
    weights.direct_weight = normalizedDirectWeights[ticker] ?? 0;
    weights.etf_lookthrough_weight = Number(weights.etf_lookthrough_weight.toFixed(4));
    weights.combined_weight = normalizedCombinedWeights[ticker] ?? 0;
  }

  const directSectorWeights: Record<string, number> = {};
  const stockSectorResults = await Promise.all(
    [...new Set(directStockTickers)].map((ticker) => fetchEquitySector(ticker, rowByTicker)),
  );
  for (const [ticker, sector] of stockSectorResults) {
    const directWeight = normalizedDirectWeights[ticker] ?? 0;
    directSectorWeights[sector] = (directSectorWeights[sector] ?? 0) + directWeight;
  }

  const tickerTable = Object.entries(tickerWeightsByTicker)
    .map(([ticker, weights]) => ({
      ticker,
      direct_weight: Number(weights.direct_weight.toFixed(4)),
      etf_lookthrough_weight: Number(weights.etf_lookthrough_weight.toFixed(4)),
      combined_weight: Number(weights.combined_weight.toFixed(4)),
      notional: notionalByTicker[ticker] ?? new Notional(),
    }))
    .sort((left, right) => right.combined_weight - left.combined_weight);

  const combinedSectorWeights = { ...etfSectorWeights };
  for (const [sector, weight] of Object.entries(directSectorWeights)) {
    combinedSectorWeights[sector] = (combinedSectorWeights[sector] ?? 0) + weight;
  }
  const etfSleeveTotal = Object.values(etfSectorWeights).reduce((sum, value) => sum + value, 0);
  const sectorTable = Object.entries(combinedSectorWeights)
    .map(([sector, weight]) => ({
      sector,
      stock_weight: Number((directSectorWeights[sector] ?? 0).toFixed(4)),
      etf_lookthrough_weight: Number((etfSectorWeights[sector] ?? 0).toFixed(4)),
      portfolio_weight: Number(weight.toFixed(4)),
      within_etf_sleeve_weight:
        etfSleeveTotal > 0
          ? Number((((etfSectorWeights[sector] ?? 0) / etfSleeveTotal) * 100).toFixed(4))
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
        sectorTable.reduce((sum, row) => sum + Number(row.within_etf_sleeve_weight), 0).toFixed(4),
      ),
    },
  };
}
