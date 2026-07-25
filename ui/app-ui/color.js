import { parseMarketCap } from "./format.js";

const BACKEND_MEDIAN_SCORE = 5.0;
const TARGET_FORMATS = new Set([
  "score",
  "percent_neutral",
  "ratio_percent_neutral",
  "number",
  "market_cap",
]);
const TARGET_KEYS = new Set(["rank", "rsi", "market_cap"]);
const INVERT_KEYS = new Set([
  "rank",
  "pe",
  "pe_forward",
  "ps",
  "ps_forward",
  "peg",
  "debt_to_equity",
]);

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function getScoreColor(value, meta) {
  if (value == null || !meta) return null;

  if (meta.standardRange) {
    const { min, max } = meta.standardRange;
    if (value <= min) {
      return meta.invert ? "var(--positive)" : "var(--negative)";
    }
    if (value >= max) {
      return meta.invert ? "var(--negative)" : "var(--positive)";
    }
  }

  if (value <= meta.lowThreshold) {
    return meta.invert ? "var(--positive)" : "var(--negative)";
  }

  if (value >= meta.highThreshold) {
    return meta.invert ? "var(--negative)" : "var(--positive)";
  }

  return null;
}

export function calculateScoreColorMetadata(
  rows,
  cols,
  { colorBandFraction = 0.5, keyStandards = null } = {},
) {
  const metadata = {};
  const resolvedStandards = keyStandards || {};

  cols.forEach((col) => {
    if (!TARGET_FORMATS.has(col.format) && !TARGET_KEYS.has(col.key)) {
      return;
    }

    const values = rows
      .map((row) => {
        if (col.key === "market_cap") {
          return parseMarketCap(row.market_cap);
        }
        return row[col.key];
      })
      .map((v) => {
        if (v == null) return null;
        const numeric = Number(v);
        return Number.isNaN(numeric) ? null : numeric;
      })
      .filter((v) => v != null);

    if (!values.length) return;

    const min = Math.min(...values);
    const max = Math.max(...values);

    const med = col.format === "score" ? BACKEND_MEDIAN_SCORE : median(values);
    const invert = INVERT_KEYS.has(col.key);
    const standardRange = resolvedStandards[col.key] || null;

    metadata[col.key] = {
      median: med,
      min,
      max,
      invert,
      standardRange,
      lowThreshold: min + colorBandFraction * (med - min),
      highThreshold: max - colorBandFraction * (max - med),
    };
  });

  return metadata;
}
