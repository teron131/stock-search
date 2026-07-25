/** Fetch ETF snapshots from official providers with StockAnalysis fallback data. */

import { getOfficialEtfHoldingsSnapshot } from "../data-sources/etf-officials/index.js";
import {
  type StockAnalysisEtfSnapshot,
  StockAnalysisSource,
} from "../data-sources/stockanalysis/index.js";
import { ETF_QUOTE_TYPE, YahooFinanceSource } from "../data-sources/yahoo-finance.js";
import { normalizeTicker } from "../utils.js";
import { normalizeEtfSectors } from "./sectors.js";
import type { EtfSector, EtfSnapshotResult } from "./types.js";

const FUND_FAMILY_KEYS = ["fund_family", "fundFamily"] as const;

export function fundFamilyFromIndicators(indicators: Record<string, unknown>): unknown {
  for (const key of FUND_FAMILY_KEYS) {
    if (indicators[key]) {
      return indicators[key];
    }
  }
  return null;
}

/** Fetch one ETF holdings snapshot from the best available source. */
export async function getEtfSnapshot(
  tickerInput: string,
  indicatorContext: Record<string, unknown> = {},
): Promise<EtfSnapshotResult> {
  const ticker = normalizeTicker(tickerInput);
  const officialSnapshot = await getOfficialEtfHoldingsSnapshot({
    ticker,
    fundFamily: fundFamilyFromIndicators(indicatorContext),
    name: indicatorContext.name,
  });
  if (officialSnapshot.holdings.length > 0) {
    let sectors: EtfSector[] = [];
    try {
      const stockAnalysisSnapshot: StockAnalysisEtfSnapshot = await new StockAnalysisSource(
        ticker,
      ).getEtfHoldingsSnapshot();
      sectors = normalizeEtfSectors(stockAnalysisSnapshot.sectors);
    } catch {
      sectors = [];
    }
    return {
      holdings: officialSnapshot.holdings,
      sectors,
      error: null,
    };
  }

  const snapshot: StockAnalysisEtfSnapshot = await new StockAnalysisSource(
    ticker,
  ).getEtfHoldingsSnapshot();
  return {
    holdings: snapshot.holdings,
    sectors: normalizeEtfSectors(snapshot.sectors),
    error: snapshot.error,
  };
}

export async function isEtfTicker(
  ticker: string,
  stockEntry: { indicators: Record<string, unknown> } | null,
): Promise<boolean> {
  const cachedQuoteType = String(stockEntry?.indicators.quote_type ?? "")
    .trim()
    .toUpperCase();
  if (cachedQuoteType) {
    return cachedQuoteType === ETF_QUOTE_TYPE;
  }
  const liveIndicators = await new YahooFinanceSource(ticker).getIndicatorsSnapshot();
  return String(liveIndicators.quote_type ?? "").toUpperCase() === ETF_QUOTE_TYPE;
}
