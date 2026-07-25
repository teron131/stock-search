/** Build search identity for ticker-specific news queries. */

import { YahooFinanceSource } from "../../data-sources/yahoo-finance.js";
import { normalizeTicker } from "../../utils.js";

const COMPANY_NAME_STOP_WORDS = new Set([
  "ads",
  "adr",
  "class",
  "common",
  "corp",
  "corporation",
  "depositary",
  "inc",
  "incorporated",
  "limited",
  "ltd",
  "ordinary",
  "plc",
  "shares",
  "stock",
]);

export type NewsTickerIdentity = {
  ticker: string;
  companyName: string | null;
  label: string;
  searchTerms: string[];
};

function cleanCompanyName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim().replace(/\s+/g, " ");
  return name && !/^[A-Z0-9.-]+$/.test(name) ? name : null;
}

function addSearchTerm(terms: string[], seen: Set<string>, term: string): void {
  const normalizedTerm = term.trim().replace(/\s+/g, " ");
  const key = normalizedTerm.toLowerCase();
  if (!normalizedTerm || seen.has(key)) {
    return;
  }
  seen.add(key);
  terms.push(normalizedTerm);
}

function companyNameSearchTerms(companyName: string | null): string[] {
  if (!companyName) {
    return [];
  }

  const terms: string[] = [];
  const seen = new Set<string>();
  addSearchTerm(terms, seen, companyName.replace(/\./g, ""));

  const words = companyName
    .replace(/[^\p{L}\p{N}&]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => {
      const key = word.toLowerCase();
      return word.length >= 3 && !/^\d+$/.test(word) && !COMPANY_NAME_STOP_WORDS.has(key);
    });
  if (words.length > 0) {
    addSearchTerm(terms, seen, words.join(" "));
  }
  for (const word of words.slice(0, 4)) {
    addSearchTerm(terms, seen, word);
  }
  return terms;
}

export function buildNewsTickerIdentity(
  tickerInput: string,
  companyNameInput: unknown = null,
): NewsTickerIdentity {
  const ticker = normalizeTicker(tickerInput);
  const companyName = cleanCompanyName(companyNameInput);
  const label = companyName ? `${ticker} (${companyName})` : ticker;
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const term of companyNameSearchTerms(companyName)) {
    addSearchTerm(terms, seen, term);
  }
  addSearchTerm(terms, seen, ticker);
  return {
    ticker,
    companyName,
    label,
    searchTerms: terms,
  };
}

export async function resolveTickerIdentityFromYahoo(ticker: string): Promise<NewsTickerIdentity> {
  const metadata = await new YahooFinanceSource(ticker).getSymbolMetadataSnapshot();
  return buildNewsTickerIdentity(ticker, metadata.name);
}
