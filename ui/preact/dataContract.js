import { normalizeTicker } from "./format.js";

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizePortfolioPositions(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  if (Array.isArray(payload.positions)) {
    return payload.positions;
  }

  return [];
}

function normalizeDashboardRowsPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (!Array.isArray(payload.rows)) {
    return null;
  }

  const rows = payload.rows
    .filter((row) => row && typeof row === "object")
    .map((row) => ({ ...row, ticker: normalizeTicker(row.ticker) }));

  return {
    rows,
    generated_at:
      typeof payload.generated_at === "string" ? payload.generated_at : null,
  };
}

function buildRowsFromSplitStatic({ portfolioPayload, statsPayload }) {
  const positions = normalizePortfolioPositions(portfolioPayload);
  const statsByTicker =
    statsPayload && typeof statsPayload === "object" ? statsPayload : {};

  const rowsByTicker = new Map();

  positions.forEach((position) => {
    if (!position || typeof position !== "object") return;
    const ticker = normalizeTicker(position.ticker);
    if (!ticker) return;

    const stats =
      statsByTicker[ticker] && typeof statsByTicker[ticker] === "object"
        ? statsByTicker[ticker]
        : {};

    const quantity = toNumber(position.quantity, 0);
    const delta = toNumber(position.delta, 0);
    const price =
      stats.current_price != null
        ? toNumber(stats.current_price, 0)
        : toNumber(stats.price, 0);
    const effectiveShares = quantity + delta * 100;

    rowsByTicker.set(ticker, {
      ticker,
      quantity,
      delta,
      current_price: stats.current_price ?? stats.price ?? null,
      notional: price > 0 ? effectiveShares * price : 0,
      ...stats,
    });
  });

  Object.entries(statsByTicker).forEach(([tickerRaw, statsValue]) => {
    const ticker = normalizeTicker(tickerRaw);
    if (!ticker || rowsByTicker.has(ticker)) return;
    if (!statsValue || typeof statsValue !== "object") return;

    const stats = statsValue;
    rowsByTicker.set(ticker, {
      ticker,
      quantity: 0,
      delta: 0,
      current_price: stats.current_price ?? stats.price ?? null,
      notional: 0,
      ...stats,
    });
  });

  return Array.from(rowsByTicker.values());
}

export function normalizeApiDashboardPayload(payload) {
  const normalized = normalizeDashboardRowsPayload(payload);
  if (!normalized) return null;
  return normalized;
}

export function normalizeStaticDashboardPayload({
  portfolioPayload,
  statsPayload,
  evalPayload,
}) {
  const evalData =
    evalPayload && typeof evalPayload === "object" ? evalPayload : {};

  const dashboardPayload = normalizeDashboardRowsPayload(portfolioPayload);
  if (dashboardPayload) {
    return {
      dashData: dashboardPayload,
      evalData,
    };
  }

  const rows = buildRowsFromSplitStatic({ portfolioPayload, statsPayload });
  if (!rows.length) {
    return null;
  }

  return {
    dashData: {
      rows,
      generated_at: new Date().toISOString(),
    },
    evalData,
  };
}

export function isValidStaticPortfolioPayload(payload) {
  if (Array.isArray(payload)) return true;
  if (!payload || typeof payload !== "object") return false;
  return Array.isArray(payload.rows) || Array.isArray(payload.positions);
}
