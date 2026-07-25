/** ETF holdings and sector allocation extraction. */

import { z } from "zod";

import { SECTOR_LABELS, SECTOR_PATTERN_RULES } from "../../../models/labels.js";
import type { StockAnalysisEtfHolding, StockAnalysisEtfSector } from "../schemas.js";
import { answerWithExaOrDefault, loadStockAnalysisPageOrDefault } from "./exa-client.js";
import { STOCKANALYSIS_ETF_HOLDINGS_URL } from "./urls.js";

const EtfHoldingSchema = z
  .object({
    ticker: z.string().describe("ETF holding ticker symbol."),
    name: z.string().nullable().optional().describe("ETF holding company name."),
    weight: z.number().describe("ETF holding portfolio weight percentage."),
  })
  .describe("One ETF holding extracted from StockAnalysis.");

const EtfHoldingsSchema = z
  .object({
    holdings: z
      .array(EtfHoldingSchema)
      .default([])
      .describe("ETF holdings ranked by portfolio weight."),
  })
  .describe("ETF holdings payload extracted from StockAnalysis.");

const EtfSectorSchema = z
  .object({
    name: z.string().describe("ETF sector name."),
    weight: z.number().describe("ETF sector portfolio weight percentage."),
  })
  .describe("One ETF sector exposure row extracted from StockAnalysis.");

const EtfSectorsSchema = z
  .object({
    sectors: z.array(EtfSectorSchema).default([]).describe("ETF sector exposure rows."),
  })
  .describe("ETF sector exposure payload extracted from StockAnalysis.");

function normalizeSectorName(value: string): string {
  const sectorText = value.trim();
  for (const label of Object.values(SECTOR_LABELS)) {
    if (sectorText.toLowerCase() === label.toLowerCase()) {
      return label;
    }
  }
  for (const [pattern, label] of SECTOR_PATTERN_RULES) {
    if (new RegExp(pattern, "i").test(sectorText)) {
      return label;
    }
  }
  return SECTOR_LABELS.other;
}

/** Load ETF holdings from the StockAnalysis holdings page. */
export async function loadEtfHoldingsSnapshot(
  tickerLower: string,
): Promise<StockAnalysisEtfHolding[]> {
  const url = STOCKANALYSIS_ETF_HOLDINGS_URL.replace("{ticker}", tickerLower);
  const output = await loadStockAnalysisPageOrDefault({
    urls: url,
    outputSchema: EtfHoldingsSchema,
    defaultValue: { holdings: [] },
    instruction: [
      `Extract ETF holdings for ${tickerLower.toUpperCase()} from the supplied StockAnalysis holdings table.`,
      `Source URL: ${url}`,
      "Return holdings in displayed table order.",
      "Use weight as a 0-100 numeric percentage.",
      "Preserve non-US exchange prefixes or suffixes when StockAnalysis displays them.",
      "Exclude US exchange prefixes.",
    ].join("\n"),
  });
  return output.holdings.map((holding) => ({
    ticker: holding.ticker,
    name: holding.name ?? null,
    weight: holding.weight,
  }));
}

/** Load ETF sector allocation from web search when page contents omit it. */
export async function loadEtfSectorsSnapshot(
  tickerLower: string,
): Promise<StockAnalysisEtfSector[]> {
  const ticker = tickerLower.toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const output = await answerWithExaOrDefault({
    outputSchema: EtfSectorsSchema,
    defaultValue: { sectors: [] },
    query: [
      `As of ${today}, find the latest sector allocation or sector exposure breakdown for ETF ${ticker}.`,
      "Prefer the ETF issuer's official website, factsheet, holdings CSV, or fund page.",
      "Use StockAnalysis or Schwab only if an issuer source is not available.",
      "Do not use Yahoo.",
    ].join(" "),
    systemPrompt: [
      "You extract ETF sector allocation data for a portfolio cache.",
      "Freshness and source quality matter: prefer official issuer sources first, then StockAnalysis, then Schwab.",
      "Return sectors only when a source explicitly shows sector allocation, sector exposure, or sector breakdown for the ETF.",
      "Do not infer sectors from holdings, company names, labels, or memory.",
      "Use numeric weights in 0-100 percentage format.",
      "Normalize sector names to concise display labels such as Technology, Healthcare, Financials, Consumer Cyclical, Consumer Defensive, Industrials, Energy, Utilities, Real Estate, Communication Services, Materials, or Other.",
      "Prefer a complete sector breakdown whose weights sum approximately to 100.",
      "If unavailable or ambiguous, return an empty sectors array.",
    ].join("\n"),
  });
  return output.sectors.map((sector) => ({
    name: normalizeSectorName(sector.name),
    weight: sector.weight,
  }));
}
