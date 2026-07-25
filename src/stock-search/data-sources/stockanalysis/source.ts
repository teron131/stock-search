/** StockAnalysis provider source implementation. */

import { loadEtfHoldingsSnapshot, loadEtfSectorsSnapshot } from "./extractors/etf.js";
import { loadFinancialsSnapshot } from "./extractors/financials.js";
import { loadSectorSnapshot } from "./extractors/sector-snapshot.js";
import { loadQuoteFields, loadStatisticsSnapshot } from "./extractors/statistics.js";
import type {
  StockAnalysisEtfSnapshot,
  StockAnalysisFinancials,
  StockAnalysisIndicatorsSnapshot,
  StockAnalysisSectorSnapshot,
  StockAnalysisStatistics,
} from "./schemas.js";
import {
  hasSectorRows,
  isFreshSectorSnapshot,
  loadCachedSectorSnapshot,
  saveCachedSectorSnapshot,
  type SectorSnapshotCacheStore,
} from "./sector-cache.js";

function hasModelData(snapshot: Record<string, unknown> | null | undefined): boolean {
  return (
    !!snapshot &&
    Object.values(snapshot).some((value) => {
      if (value == null) {
        return false;
      }
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      return true;
    })
  );
}

/** Fetch sector summary rows from StockAnalysis. */
export async function getSectorSnapshot(
  store?: SectorSnapshotCacheStore,
): Promise<StockAnalysisSectorSnapshot> {
  const cachedSnapshot = await loadCachedSectorSnapshot(store);
  if (isFreshSectorSnapshot(cachedSnapshot)) {
    return cachedSnapshot;
  }

  try {
    const snapshot = await loadSectorSnapshot();
    if (hasSectorRows(snapshot)) {
      await saveCachedSectorSnapshot(store, snapshot);
      return snapshot;
    }

    return cachedSnapshot ?? snapshot;
  } catch (error) {
    if (cachedSnapshot) {
      return cachedSnapshot;
    }
    throw error;
  }
}

export class StockAnalysisSource {
  private readonly tickerLower: string;
  private statisticsSnapshot: StockAnalysisStatistics | null = null;
  private etfSnapshot: StockAnalysisEtfSnapshot | null = null;
  private financialsSnapshot: StockAnalysisFinancials | null = null;
  private indicatorsSnapshot: StockAnalysisIndicatorsSnapshot | null = null;

  /** Initialize the StockAnalysis source for one ticker. */
  constructor(ticker: string) {
    this.tickerLower = ticker.toLowerCase().trim();
  }

  /** Fetch statistics once and reuse cached data on later calls. */
  async getStatisticsSnapshot(): Promise<StockAnalysisStatistics> {
    if (this.statisticsSnapshot) {
      return this.statisticsSnapshot;
    }

    const loaded = await loadStatisticsSnapshot(this.tickerLower);
    this.statisticsSnapshot = hasModelData(loaded) ? loaded : {};
    return this.statisticsSnapshot;
  }

  /** Fetch financials once and reuse cached data on later calls. */
  async getFinancialsSnapshot(): Promise<StockAnalysisFinancials> {
    if (this.financialsSnapshot) {
      return this.financialsSnapshot;
    }

    const loaded = await loadFinancialsSnapshot(this.tickerLower);
    this.financialsSnapshot = hasModelData(loaded) ? loaded : {};
    return this.financialsSnapshot;
  }

  /** Fetch ETF holdings and sector data for one ticker. */
  async getEtfHoldingsSnapshot(): Promise<StockAnalysisEtfSnapshot> {
    if (this.etfSnapshot) {
      return this.etfSnapshot;
    }

    const [holdings, sectors] = await Promise.all([
      loadEtfHoldingsSnapshot(this.tickerLower),
      loadEtfSectorsSnapshot(this.tickerLower),
    ]);
    this.etfSnapshot = {
      holdings,
      sectors,
      error: holdings.length === 0 && sectors.length === 0 ? "no snapshot returned" : null,
    };
    return this.etfSnapshot;
  }

  /** Return an app-facing StockAnalysis indicator set. */
  async getIndicatorsSnapshot(): Promise<StockAnalysisIndicatorsSnapshot> {
    if (this.indicatorsSnapshot) {
      return this.indicatorsSnapshot;
    }

    const [quoteFields, statistics, financials] = await Promise.all([
      loadQuoteFields(this.tickerLower),
      this.getStatisticsSnapshot(),
      this.getFinancialsSnapshot(),
    ]);
    this.indicatorsSnapshot = {
      ...quoteFields,
      ...statistics,
      ...financials,
      gross_margin: financials.gross_margin ?? statistics.gross_margin ?? null,
      operating_margin: financials.operating_margin ?? statistics.operating_margin ?? null,
      debt_to_equity: statistics.debt_to_equity ?? null,
    };
    return this.indicatorsSnapshot;
  }
}
