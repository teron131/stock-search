/** Defines official ETF holdings provider contracts. */

export type OfficialEtfHolding = {
  ticker: string;
  name: string | null;
  weight: number;
};

export type OfficialEtfProviderMatchContext = {
  ticker: string;
  fundFamily?: unknown;
  name?: unknown;
};

export type OfficialEtfHoldingsSnapshot = {
  holdings: OfficialEtfHolding[];
  source: string | null;
  error: string | null;
};

export type OfficialEtfHoldingsProvider = {
  issuer: string;
  priority: number;
  matches(context: OfficialEtfProviderMatchContext): boolean;
  load(context: OfficialEtfProviderMatchContext): Promise<OfficialEtfHoldingsSnapshot>;
};
