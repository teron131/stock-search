import { useCallback, useMemo, useRef, useState } from "https://esm.sh/preact@10.19.6/hooks";

import { CONFIG } from "./config.js";
import { normalizeTicker } from "./format.js";

function withCacheBuster(url) {
  const cacheBuster = `_=${Date.now()}`;
  return url.includes("?") ? `${url}&${cacheBuster}` : `${url}?${cacheBuster}`;
}

function ensureEvalEntries(evalData) {
  if (Array.isArray(evalData)) {
    return evalData.map((e) => ({
      ...e,
      bull: e.bull ?? e.bull_probability,
      bear: e.bear ?? e.bear_probability,
    }));
  }

  if (evalData && typeof evalData === "object") {
    return Object.entries(evalData).map(([ticker, data]) => ({
      ...data,
      ticker,
      bull: data.bull ?? data.bull_probability,
      bear: data.bear ?? data.bear_probability,
    }));
  }

  return [];
}

function mergeRows(dashData, evalData) {
  const portfolioMap = new Map((dashData.rows || []).map((r) => [normalizeTicker(r.ticker), r]));
  const evalEntries = ensureEvalEntries(evalData);
  const evalMap = new Map(evalEntries.map((e) => [normalizeTicker(e.ticker), e]));

  const allTickers = new Set([...portfolioMap.keys(), ...evalMap.keys()]);

  return Array.from(allTickers).map((t) => {
    const p = portfolioMap.get(t) || {};
    const e = evalMap.get(t) || {};
    const safeTicker = p.ticker || e.ticker || t;

    return {
      ...p,
      ...e,
      ticker: safeTicker,
      name: p.name || e.name || safeTicker,
    };
  });
}

function calculateRanks(rows) {
  const sorted = rows
    .map((row, index) => ({ index, score: Number(row.overall) || 0 }))
    .sort((a, b) => b.score - a.score);

  const out = [...rows];
  sorted.forEach((item, rank) => {
    out[item.index] = { ...out[item.index], rank: rank + 1 };
  });

  return out;
}

function calculateWeights(rows) {
  const totalVal = rows.reduce((acc, r) => acc + (Number(r.notional) || 0), 0);
  if (totalVal <= 0) {
    return { totalVal: 0, rows: rows.map((r) => ({ ...r, weight_pct: 0 })) };
  }

  return {
    totalVal,
    rows: rows.map((r) => {
      const notional = Number(r.notional);
      if (!notional || Number.isNaN(notional)) {
        return { ...r, weight_pct: null };
      }
      return { ...r, weight_pct: (notional / totalVal) * 100 };
    }),
  };
}

function calculateWeightedChange(rows, totalVal) {
  if (totalVal <= 0) return { percent: 0, absolute: 0 };

  const absolute = rows.reduce((acc, r) => {
    const cp = Number(r.change_percent) || 0;
    const notional = Number(r.notional) || 0;
    return acc + (cp / 100) * notional / (1 + cp / 100);
  }, 0);

  const percent = (absolute / (totalVal - absolute)) * 100;
  return { percent, absolute };
}

async function determineDemoPath() {
  try {
    const res = await fetch(withCacheBuster(`${CONFIG.demoPaths.primary}/portfolio.json`));
    if (!res.ok) return CONFIG.demoPaths.fallback;

    const payload = await res.json();
    const isValid = Array.isArray(payload) || (payload && Array.isArray(payload.rows));
    return isValid ? CONFIG.demoPaths.primary : CONFIG.demoPaths.fallback;
  } catch {
    return CONFIG.demoPaths.fallback;
  }
}

async function fetchPortfolioData(endpoints) {
  const fetches = [
    fetch(withCacheBuster(endpoints.portfolio)),
    fetch(withCacheBuster(endpoints.eval)),
  ];

  if (endpoints.stats) {
    fetches.push(fetch(withCacheBuster(endpoints.stats)));
  }

  const responses = await Promise.all(fetches);
  if (responses.some((r) => !r.ok)) throw new Error("API Failure");

  const portfolioRaw = await responses[0].json();
  const evalData = await responses[1].json();

  // API response already joined
  if (portfolioRaw.rows) {
    return { dashData: portfolioRaw, evalData };
  }

  // Sample/static response: join portfolio list with stats
  let statsData = {};
  if (endpoints.stats) {
    statsData = await responses[2].json();
  }

  if (Array.isArray(portfolioRaw)) {
    const rows = portfolioRaw.map((pos) => {
      const stat = statsData[pos.ticker] || {};
      const quantity = Number(pos.quantity || 0);
      const price = Number(stat.current_price || 0);
      const delta = Number(pos.delta || 1);
      const notional = quantity * price * delta;

      return {
        ...stat,
        ...pos,
        notional,
        ticker: pos.ticker,
        current_price: price,
        quantity,
      };
    });

    return {
      dashData: { rows, generated_at: new Date().toISOString() },
      evalData,
    };
  }

  return { dashData: { rows: [] }, evalData };
}

export function usePortfolioData() {
  const [rows, setRows] = useState([]);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [loadingMode, setLoadingMode] = useState("idle");
  const [isUsingDemoData, setIsUsingDemoData] = useState(false);
  const [lastError, setLastError] = useState(null);

  const lastLoadWasBackground = useRef(false);

  const stats = useMemo(() => {
    const { totalVal, rows: weighted } = calculateWeights(rows);
    const change = calculateWeightedChange(weighted, totalVal);

    return {
      totalVal,
      change,
      positions: weighted.length,
    };
  }, [rows]);

  const load = useCallback(async ({ background = false } = {}) => {
    if (loadingMode !== "idle") return;

    lastLoadWasBackground.current = background;
    setLoadingMode(background ? "background" : "foreground");
    setLastError(null);

    try {
      // Demo mode can optionally slow-load for effect, but keep it simple here.
      if (CONFIG.isDemoMode) {
        setIsUsingDemoData(true);
        const basePath = await determineDemoPath();

        const { dashData, evalData } = await fetchPortfolioData({
          portfolio: `${basePath}/portfolio.json`,
          eval: `${basePath}/eval.json`,
          stats: `${basePath}/stats.json`,
        });

        const merged = calculateRanks(mergeRows(dashData, evalData));
        setRows(merged);
        setGeneratedAt(dashData.generated_at || new Date().toISOString());
        return;
      }

      setIsUsingDemoData(false);
      const { dashData, evalData } = await fetchPortfolioData(CONFIG.endpoints);
      const merged = calculateRanks(mergeRows(dashData, evalData));
      setRows(merged);
      setGeneratedAt(dashData.generated_at || new Date().toISOString());
    } catch (e) {
      setLastError(e);
      if (!background) {
        setRows([]);
      }
    } finally {
      setLoadingMode("idle");
    }
  }, [loadingMode]);

  const addOrUpdate = useCallback(
    async ({ ticker, quantity, existingQuantity }) => {
      if (isUsingDemoData) return { ok: false, reason: "demo" };

      const t = normalizeTicker(ticker);
      const q = Number(quantity);
      if (!t || Number.isNaN(q)) return { ok: false, reason: "invalid" };

      if (existingQuantity != null && existingQuantity !== 0) {
        const confirmed = window.confirm(
          `Ticker ${t} already exists with ${existingQuantity}. Update to ${q}?`,
        );
        if (!confirmed) return { ok: false, reason: "cancelled" };
      }

      const res = await fetch(CONFIG.endpoints.position, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: t,
          quantity: q,
          delta: 1.0,
          bucket: CONFIG.defaultBucket,
        }),
      });

      if (!res.ok) return { ok: false, reason: "server" };
      await load({ background: true });
      return { ok: true };
    },
    [isUsingDemoData, load],
  );

  const remove = useCallback(
    async ({ ticker }) => {
      if (isUsingDemoData) return { ok: false, reason: "demo" };

      const t = normalizeTicker(ticker);
      if (!t) return { ok: false, reason: "invalid" };

      const confirmed = window.confirm(`CONFIRM: Eliminate ${t} from portfolio?`);
      if (!confirmed) return { ok: false, reason: "cancelled" };

      const res = await fetch(`${CONFIG.endpoints.position}/${t}`, { method: "DELETE" });
      if (!res.ok) return { ok: false, reason: "server" };

      await load({ background: true });
      return { ok: true };
    },
    [isUsingDemoData, load],
  );

  const topTickers = useMemo(() => {
    return [...rows]
      .sort((a, b) => (Number(b.weight_pct) || 0) - (Number(a.weight_pct) || 0))
      .map((r) => normalizeTicker(r.ticker))
      .filter((t, i, self) => t && t.length < CONFIG.maxTickerLength && self.indexOf(t) === i)
      .slice(0, CONFIG.maxTickerTapeCount);
  }, [rows]);

  return {
    rows,
    generatedAt,
    isLoading: loadingMode !== "idle",
    isBackgroundLoading: loadingMode === "background",
    isUsingDemoData,
    lastError,
    stats,
    topTickers,
    actions: {
      load,
      addOrUpdate,
      remove,
    },
  };
}
