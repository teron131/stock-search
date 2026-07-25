/** Parse Finviz quote-page snapshot tables into typed provider fields. */

import type { FinvizQuoteSnapshot } from "./schemas.js";

const NULL_TEXTS = new Set(["", "-", "--", "n/a", "na", "none"]);
const NUMBER_SUFFIX_MULTIPLIERS: Record<string, number> = {
  K: 1e3,
  M: 1e6,
  B: 1e9,
  T: 1e12,
};
const FINVIZ_LABELS = {
  price: "Price",
  marketCap: "Market Cap",
  revenue: "Sales",
  pe: "P/E",
  peForward: "Forward P/E",
  ps: "P/S",
  peg: "PEG",
  beta: "Beta",
  rsi: "RSI (14)",
  roe: "ROE",
  roic: "ROIC",
  grossMargin: "Gross Margin",
  operatingMargin: "Oper. Margin",
  profitMargin: "Profit Margin",
  debtToEquity: "Debt/Eq",
  revenueGrowth: "Sales Y/Y TTM",
  epsThisYearGrowth: "EPS this Y",
  epsNextYearGrowth: "EPS next Y",
  epsNextFiveYearGrowth: "EPS next 5Y",
  epsYearOverYearTtmGrowth: "EPS Y/Y TTM",
  epsPastThreeFiveYearGrowth: "EPS past 3/5Y",
  salesPastThreeFiveYearGrowth: "Sales past 3/5Y",
} as const;

type FinvizSnapshotLabel = (typeof FINVIZ_LABELS)[keyof typeof FINVIZ_LABELS];

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#37;/g, "%");
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snapshotCellTexts(html: string): string[] {
  return [
    ...html.matchAll(
      /<td\b[^>]*class=["'][^"']*\bsnapshot-td2\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi,
    ),
  ]
    .map((match) => stripTags(match[1] ?? ""))
    .filter(Boolean);
}

function snapshotPairs(html: string): Record<string, string> {
  const cells = snapshotCellTexts(html);
  const pairs: Record<string, string> = {};
  for (let index = 0; index < cells.length - 1; index += 2) {
    pairs[cells[index] ?? ""] = cells[index + 1] ?? "";
  }
  return pairs;
}

export function parseFinvizNumber(value: string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const normalized = value.trim().replace(/\u2212/g, "-");
  if (NULL_TEXTS.has(normalized.toLowerCase())) {
    return null;
  }

  const firstToken = normalized.split(/\s+/)[0] ?? "";
  const match = firstToken.match(
    /^\(?\s*[$€£¥]?\s*([+-]?\d[\d,.]*)(?:\.(\d+))?\s*([KMBT])?\s*%?\s*\)?$/i,
  );
  if (!match?.[1]) {
    return null;
  }

  const integerPart = match[1].replace(/,/g, "");
  const decimalPart = match[2] ? `.${match[2]}` : "";
  const parsed = Number(`${integerPart}${decimalPart}`);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const suffix = match[3]?.toUpperCase() ?? "";
  const multiplier = NUMBER_SUFFIX_MULTIPLIERS[suffix] ?? 1;
  const sign = firstToken.trim().startsWith("(") && firstToken.trim().endsWith(")") ? -1 : 1;
  return sign * parsed * multiplier;
}

function parseSecondFinvizNumber(value: string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const [, second] = value.trim().split(/\s+/, 2);
  return parseFinvizNumber(second);
}

function pickNumber(pairs: Record<string, string>, label: FinvizSnapshotLabel): number | null {
  return parseFinvizNumber(pairs[label]);
}

function pickText(html: string, filterPrefix: "sec_" | "ind_"): string | null {
  const match = html.match(
    new RegExp(`<a\\b[^>]*href=["'][^"']*f=${filterPrefix}[^"']*["'][^>]*>([\\s\\S]*?)<\\/a>`, "i"),
  );
  const value = match?.[1] == null ? null : stripTags(match[1]);
  return value && !NULL_TEXTS.has(value.toLowerCase()) ? value : null;
}

function normalizeFinvizSector(value: string | null): string | null {
  return value === "Financial" ? "Financial Services" : value;
}

/** Parse the quote snapshot table from one Finviz quote HTML page. */
export function parseFinvizQuoteSnapshot(
  html: string,
  ticker: string,
  url: string,
  fetchedAt: string | null = null,
): FinvizQuoteSnapshot {
  const raw = snapshotPairs(html);

  return {
    ticker: ticker.toUpperCase().trim(),
    source: "finviz",
    fetched_at: fetchedAt,
    url,
    raw,
    sector_name: normalizeFinvizSector(pickText(html, "sec_")),
    industry_name: pickText(html, "ind_"),
    price: pickNumber(raw, FINVIZ_LABELS.price),
    market_cap: pickNumber(raw, FINVIZ_LABELS.marketCap),
    revenue: pickNumber(raw, FINVIZ_LABELS.revenue),
    pe: pickNumber(raw, FINVIZ_LABELS.pe),
    pe_forward: pickNumber(raw, FINVIZ_LABELS.peForward),
    ps: pickNumber(raw, FINVIZ_LABELS.ps),
    peg: pickNumber(raw, FINVIZ_LABELS.peg),
    beta: pickNumber(raw, FINVIZ_LABELS.beta),
    rsi: pickNumber(raw, FINVIZ_LABELS.rsi),
    roe: pickNumber(raw, FINVIZ_LABELS.roe),
    roic: pickNumber(raw, FINVIZ_LABELS.roic),
    gross_margin: pickNumber(raw, FINVIZ_LABELS.grossMargin),
    operating_margin: pickNumber(raw, FINVIZ_LABELS.operatingMargin),
    profit_margin: pickNumber(raw, FINVIZ_LABELS.profitMargin),
    debt_to_equity: pickNumber(raw, FINVIZ_LABELS.debtToEquity),
    revenue_growth: pickNumber(raw, FINVIZ_LABELS.revenueGrowth),
    eps_this_y_growth: pickNumber(raw, FINVIZ_LABELS.epsThisYearGrowth),
    eps_next_y_growth: pickNumber(raw, FINVIZ_LABELS.epsNextYearGrowth),
    eps_next_5y_growth: pickNumber(raw, FINVIZ_LABELS.epsNextFiveYearGrowth),
    eps_past_3y_growth: pickNumber(raw, FINVIZ_LABELS.epsPastThreeFiveYearGrowth),
    eps_past_5y_growth: parseSecondFinvizNumber(raw[FINVIZ_LABELS.epsPastThreeFiveYearGrowth]),
    sales_past_3y_growth: pickNumber(raw, FINVIZ_LABELS.salesPastThreeFiveYearGrowth),
    sales_past_5y_growth: parseSecondFinvizNumber(raw[FINVIZ_LABELS.salesPastThreeFiveYearGrowth]),
    eps_yoy_ttm_growth: pickNumber(raw, FINVIZ_LABELS.epsYearOverYearTtmGrowth),
  };
}
