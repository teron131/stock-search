/** Resolve ETF snapshots with cache-first semantics. */

import { isCacheTimestampFresh } from "../cache.js";
import { ETF_QUOTE_TYPE } from "../data-sources/yahoo-finance.js";
import type { StockEntry } from "../storage/index.js";
import { normalizeTicker } from "../utils.js";
import { normalizeEtfSectors } from "./sectors.js";
import { getEtfSnapshot } from "./sources.js";
import type { EtfHolding, EtfSector, EtfSnapshotCacheResult, EtfSnapshotResult } from "./types.js";

const ETF_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const ETF_HOLDINGS_FETCHED_AT_FIELD = "etf_holdings_fetched_at";

function readEtfCache(
  indicators: Record<string, unknown>,
): { holdings: EtfHolding[]; sectors: EtfSector[] } | null {
  if (!Array.isArray(indicators.etf_holdings)) {
    return null;
  }

  const holdings = indicators.etf_holdings
    .filter((holding) => typeof holding === "object" && holding !== null)
    .map((holding) => holding as Record<string, unknown>)
    .map((holding) => ({
      ticker: normalizeTicker(holding.ticker),
      name: typeof holding.name === "string" && holding.name.trim() ? holding.name.trim() : null,
      weight: Number(holding.weight),
    }))
    .filter((holding) => holding.ticker && Number.isFinite(holding.weight) && holding.weight > 0);
  const sectors = Array.isArray(indicators.etf_sectors)
    ? normalizeEtfSectors(
        indicators.etf_sectors
          .filter((sector) => typeof sector === "object" && sector !== null)
          .map((sector) => sector as Record<string, unknown>)
          .map((sector) => ({
            name: typeof sector.name === "string" ? sector.name : null,
            weight: Number(sector.weight),
          })),
      )
    : [];
  if (holdings.length === 0 && sectors.length === 0) {
    return null;
  }

  return { holdings, sectors };
}

export function loadAnyEtfCache(
  indicators: Record<string, unknown>,
): { holdings: EtfHolding[]; sectors: EtfSector[] } | null {
  return readEtfCache(indicators);
}

function loadFreshEtfCache(
  indicators: Record<string, unknown>,
  now: number,
): { holdings: EtfHolding[]; sectors: EtfSector[] } | null {
  if (
    !isCacheTimestampFresh(indicators[ETF_HOLDINGS_FETCHED_AT_FIELD], now, ETF_CACHE_MAX_AGE_MS)
  ) {
    return null;
  }
  return readEtfCache(indicators);
}

function emptyEtfSnapshot(error: string | null = null): EtfSnapshotResult {
  return {
    holdings: [],
    sectors: [],
    error,
  };
}

function storeEtfCache(
  indicators: Record<string, unknown>,
  holdings: EtfHolding[],
  sectors: EtfSector[],
  now: number,
): Record<string, unknown> {
  return {
    ...indicators,
    etf_holdings: holdings,
    etf_sectors: sectors,
    [ETF_HOLDINGS_FETCHED_AT_FIELD]: new Date(now).toISOString(),
  };
}

/** Resolve one ETF snapshot with cache-first semantics and optional live refresh. */
export async function resolveEtfSnapshotCache(
  tickerInput: string,
  stockEntry: StockEntry | null,
  allowLiveFetch: boolean,
  now = Date.now(),
): Promise<EtfSnapshotCacheResult> {
  const ticker = normalizeTicker(tickerInput);
  const indicators = stockEntry?.indicators ?? {};
  const cachedSnapshot = loadFreshEtfCache(indicators, now);
  if (cachedSnapshot && (cachedSnapshot.holdings.length > 0 || !allowLiveFetch)) {
    return {
      snapshot: {
        holdings: cachedSnapshot.holdings,
        sectors: cachedSnapshot.sectors,
        error: null,
      },
      refreshedIndicators: null,
      didRefresh: false,
    };
  }

  const staleSnapshot = loadAnyEtfCache(indicators);
  if (!allowLiveFetch) {
    return {
      snapshot: staleSnapshot
        ? {
            holdings: staleSnapshot.holdings,
            sectors: staleSnapshot.sectors,
            error: null,
          }
        : emptyEtfSnapshot(),
      refreshedIndicators: null,
      didRefresh: false,
    };
  }

  const snapshot = await getEtfSnapshot(ticker, indicators);
  if (!snapshot.error) {
    return {
      snapshot,
      refreshedIndicators: storeEtfCache(
        { ...indicators, quote_type: ETF_QUOTE_TYPE },
        snapshot.holdings,
        snapshot.sectors,
        now,
      ),
      didRefresh: true,
    };
  }

  return {
    snapshot: staleSnapshot
      ? {
          holdings: staleSnapshot.holdings,
          sectors: staleSnapshot.sectors,
          error: snapshot.error,
        }
      : emptyEtfSnapshot(snapshot.error),
    refreshedIndicators: null,
    didRefresh: false,
  };
}
