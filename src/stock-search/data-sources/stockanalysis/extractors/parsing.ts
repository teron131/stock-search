/** Owns StockAnalysis text-to-number and markdown-table parsing primitives. */

const NULL_NUMBER_TEXTS = new Set(["-", "--", "n/a", "na", "none"]);
const NUMBER_SUFFIX_MULTIPLIERS: Record<string, number> = {
  K: 1e3,
  M: 1e6,
  B: 1e9,
  T: 1e12,
};

export function parseStockAnalysisNumber(value: string, defaultMultiplier = 1): number | null {
  const normalized = value.trim();
  if (!normalized || NULL_NUMBER_TEXTS.has(normalized.toLowerCase())) {
    return null;
  }
  const valueMatch = normalized
    .replace(/\u2212/g, "-")
    .match(/\(?\s*[$€£¥]?\s*(-?[\d,.]+(?:\.\d+)?)\s*([KMBT])?\s*%?\s*\)?/i);
  if (!valueMatch?.[1]) {
    return null;
  }
  const numberValue = Number(valueMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(numberValue)) {
    return null;
  }
  const multiplier =
    NUMBER_SUFFIX_MULTIPLIERS[valueMatch[2]?.toUpperCase() ?? ""] ?? defaultMultiplier;
  const sign = normalized.trim().startsWith("(") && normalized.trim().endsWith(")") ? -1 : 1;
  return sign * numberValue * multiplier;
}

export function markdownTableCells(row: string): string[] {
  return row
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
}
