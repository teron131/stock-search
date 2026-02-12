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
      typeof payload.meta?.generated_at === "string"
        ? payload.meta.generated_at
        : null,
    portfolio_stats:
      payload.portfolio_stats && typeof payload.portfolio_stats === "object"
        ? payload.portfolio_stats
        : null,
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
    const price =
      stats.current_price != null
        ? toNumber(stats.current_price, 0)
        : toNumber(stats.price, 0);

    rowsByTicker.set(ticker, {
      ticker,
      quantity,
      current_price: stats.current_price ?? stats.price ?? null,
      total: price > 0 ? quantity * price : 0,
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
      current_price: stats.current_price ?? stats.price ?? null,
      total: 0,
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
      portfolio_stats: null,
    },
    evalData,
  };
}

export function isValidStaticPortfolioPayload(payload) {
  if (Array.isArray(payload)) return true;
  if (!payload || typeof payload !== "object") return false;
  return Array.isArray(payload.rows) || Array.isArray(payload.positions);
}
