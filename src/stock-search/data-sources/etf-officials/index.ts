/** Official ETF holdings provider priority registry. */

import { roundhillOfficialEtfProvider } from "./roundhill.js";
import type {
  OfficialEtfHoldingsProvider,
  OfficialEtfHoldingsSnapshot,
  OfficialEtfProviderMatchContext,
} from "./types.js";

export {
  parseRenderedRoundhillHoldingsRows,
  roundhillEtfPageUrl,
  scrapeRoundhillRenderedHoldings,
} from "./roundhill.js";
export type {
  OfficialEtfHolding,
  OfficialEtfHoldingsProvider,
  OfficialEtfHoldingsSnapshot,
  OfficialEtfProviderMatchContext,
} from "./types.js";

export const OFFICIAL_ETF_HOLDINGS_PROVIDERS: OfficialEtfHoldingsProvider[] = [
  roundhillOfficialEtfProvider,
];

/** Resolve the highest-priority official holdings provider for an ETF. */
export function resolveOfficialEtfHoldingsProvider(
  context: OfficialEtfProviderMatchContext,
): OfficialEtfHoldingsProvider | null {
  return (
    OFFICIAL_ETF_HOLDINGS_PROVIDERS.filter((provider) => provider.matches(context)).sort(
      (left, right) => right.priority - left.priority,
    )[0] ?? null
  );
}

/** Fetch official ETF holdings when a known higher-priority provider matches. */
export async function getOfficialEtfHoldingsSnapshot(
  context: OfficialEtfProviderMatchContext,
): Promise<OfficialEtfHoldingsSnapshot> {
  const provider = resolveOfficialEtfHoldingsProvider(context);
  if (!provider) {
    return {
      holdings: [],
      source: null,
      error: "no official provider matched",
    };
  }

  return provider.load(context);
}
