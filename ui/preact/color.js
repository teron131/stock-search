import { parseMarketCap } from "./format.js";

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function getScoreColor(value, meta) {
  if (value == null || !meta) return null;

  if (value <= meta.lowThreshold) {
    return meta.invert ? "var(--positive)" : "var(--negative)";
  }

  if (value >= meta.highThreshold) {
    return meta.invert ? "var(--negative)" : "var(--positive)";
  }

  return null;
}

export function calculateScoreColorMetadata(rows, cols, { colorBandFraction = 0.5 } = {}) {
  const BACKEND_MEDIAN_SCORE = 5.0;
  const targetFormats = ["score", "prob", "percent_neutral", "number", "market_cap"];
  const targetKeys = ["rank", "rsi", "market_cap"];

  const metadata = {};

  cols.forEach((col) => {
    if (!targetFormats.includes(col.format) && !targetKeys.includes(col.key)) {
      return;
    }

    const values = rows
      .map((row) => {
        if (col.key === "market_cap") {
          return parseMarketCap(row.market_cap);
        }
        return row[col.key];
      })
      .filter((v) => v != null && !Number.isNaN(Number(v)))
      .map((v) => Number(v));

    if (!values.length) return;

    const min = Math.min(...values);
    const max = Math.max(...values);

    const med = col.format === "score" ? BACKEND_MEDIAN_SCORE : median(values);
    const invert = ["rank", "bear", "pe", "pe_forward", "peg"].includes(col.key);

    metadata[col.key] = {
      median: med,
      min,
      max,
      invert,
      lowThreshold: min + colorBandFraction * (med - min),
      highThreshold: max - colorBandFraction * (max - med),
    };
  });

  return metadata;
}
