import {
  useCallback,
  useMemo,
  useRef,
  useState,
} from "https://esm.sh/preact@10.19.6/hooks";

import { CONFIG } from "./config.js";
import { normalizeTicker } from "./format.js";

const NO_EVAL_TICKERS = new Set([
  "SCHD",
  "SHLD",
  "ITA",
  "SOXX",
  "GLD",
  "VOO",
  "GRNY",
  "GRNJ",
]);

const EVAL_KEYS = [
  "overall",
  "quality",
  "valuation",
  "moat",
  "upside",
  "market_cap_score",
  "bull",
  "bear",
  "bull_probability",
  "bear_probability",
  "rank",
];

function withCacheBuster(url) {
  const cacheBuster = `_=${Date.now()}`;
  return url.includes("?") ? `${url}&${cacheBuster}` : `${url}?${cacheBuster}`;
}

async function tryFetchJson(url) {
  try {
    const res = await fetch(withCacheBuster(url));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
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
  const portfolioMap = new Map(
    (dashData.rows || []).map((r) => [normalizeTicker(r.ticker), r]),
  );
  const evalEntries = ensureEvalEntries(evalData);
  const evalMap = new Map(
    evalEntries.map((e) => [normalizeTicker(e.ticker), e]),
  );

  const allTickers = new Set([...portfolioMap.keys(), ...evalMap.keys()]);

  return Array.from(allTickers).map((t) => {
    const p = portfolioMap.get(t) || {};
    const e = evalMap.get(t) || {};
    const safeTicker = p.ticker || e.ticker || t;

    // API rows are authoritative for live stats; eval is fill-only.
    const merged = { ...p };
    Object.entries(e).forEach(([k, v]) => {
      if (merged[k] == null) {
        merged[k] = v;
      }
    });

    merged.ticker = safeTicker;
    merged.name = merged.name || e.name || safeTicker;

    if (NO_EVAL_TICKERS.has(normalizeTicker(safeTicker))) {
      EVAL_KEYS.forEach((key) => {
        merged[key] = null;
      });
    }

    return merged;
  });
}

function calculateRanks(rows) {
  const out = rows.map((row) => ({ ...row, rank: null }));

  const ranked = rows
    .map((row, index) => ({
      index,
      hasScore: row.overall != null && row.overall !== "",
      score: Number(row.overall),
    }))
    .filter((item) => item.hasScore)
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score);

  ranked.forEach((item, rank) => {
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
      const rawNotional = r.notional;
      const notional = rawNotional == null ? null : Number(rawNotional);
      if (notional == null || Number.isNaN(notional)) {
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
    return acc + ((cp / 100) * notional) / (1 + cp / 100);
  }, 0);

  const percent = (absolute / (totalVal - absolute)) * 100;
  return { percent, absolute };
}

async function determineDemoPath() {
  const stripLeadingSlashes = (p) => String(p || "").replace(/^\/+/, "");

  const isValidPortfolioPayload = (payload) =>
    Array.isArray(payload) || (payload && Array.isArray(payload.rows));

  const primary = CONFIG.demoPaths.primary;
  const fallback = CONFIG.demoPaths.fallback;

  // Prefer relative paths (works for GitHub Pages subpaths), but fall back to absolute
  // (helps if UI is served from a sub-route while backend mounts /data at root).
  const candidates = [primary, fallback].flatMap((base) => {
    if (!base) return [];
    if (String(base).startsWith("/")) return [base];
    return [base, `/${stripLeadingSlashes(base)}`];
  });

  for (const base of candidates) {
    try {
      const res = await fetch(withCacheBuster(`${base}/portfolio.json`));
      if (!res.ok) continue;
      const payload = await res.json();
      if (isValidPortfolioPayload(payload)) return base;
    } catch {
      // keep trying
    }
  }

  return fallback;
}

async function fetchStaticPortfolioData(basePath) {
  const portfolioRaw = await tryFetchJson(`${basePath}/portfolio.json`);
  if (!portfolioRaw) throw new Error("Static portfolio not found");

  const evalData = (await tryFetchJson(`${basePath}/eval.json`)) ?? {};
  const statsData = (await tryFetchJson(`${basePath}/stats.json`)) ?? {};

  if (portfolioRaw?.rows) {
    return { dashData: portfolioRaw, evalData };
  }

  if (Array.isArray(portfolioRaw)) {
    const rows = portfolioRaw.map((pos) => {
      const stat = statsData[pos.ticker] || {};
      const quantity = Number(pos.quantity || 0);
      const price = Number(stat.current_price || 0);
      const delta = Number(pos.delta ?? 0);
      const notional = (quantity + delta * 100) * price;

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
  const [colorStandards, setColorStandards] = useState(null);
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

  const applyMergedRows = useCallback((dashData, evalData) => {
    const merged = calculateRanks(mergeRows(dashData, evalData));
    setRows(merged);
    setGeneratedAt(new Date().toISOString());
  }, []);

  const load = useCallback(
    async ({ background = false } = {}) => {
      if (loadingMode !== "idle") return;

      lastLoadWasBackground.current = background;
      setLoadingMode(background ? "background" : "foreground");
      setLastError(null);

      try {
        const basePath = await determineDemoPath();

        // Demo mode: static only
        if (CONFIG.isDemoMode) {
          setIsUsingDemoData(true);
          const { dashData, evalData } =
            await fetchStaticPortfolioData(basePath);
          applyMergedRows(dashData, evalData);
          return;
        }

        // Normal mode:
        // - Stats/portfolio always via API (live)
        // - Eval cache-first (static), fallback to API
        const dashData = await (async () => {
          const res = await fetch(withCacheBuster(CONFIG.endpoints.portfolio));
          if (!res.ok) throw new Error("API Failure");
          return await res.json();
        })();

        const evalData =
          (await tryFetchJson(`${basePath}/eval.json`)) ??
          (await tryFetchJson(CONFIG.endpoints.eval)) ??
          {};
        const standardsPayload = await tryFetchJson(
          CONFIG.endpoints.colorStandards,
        );
        const standards = standardsPayload?.standards;
        if (standards && typeof standards === "object") {
          setColorStandards(standards);
        }

        setIsUsingDemoData(false);
        applyMergedRows(dashData, evalData);
      } catch (e) {
        setLastError(e);

        // If API fails, fall back to static (read-only)
        try {
          const basePath = await determineDemoPath();
          const { dashData, evalData } =
            await fetchStaticPortfolioData(basePath);
          setIsUsingDemoData(true);
          applyMergedRows(dashData, evalData);
        } catch {
          if (!background) {
            setRows([]);
          }
        }
      } finally {
        setLoadingMode("idle");
      }
    },
    [applyMergedRows, loadingMode],
  );

  const patchPortfolioPosition = useCallback(
    async ({
      ticker,
      quantity,
      delta = 0.0,
      bucket = CONFIG.defaultBucket,
    }) => {
      const normalizedTicker = normalizeTicker(ticker);
      const normalizedQuantity = Number(quantity);
      const normalizedDelta = Number(delta);
      if (!normalizedTicker || Number.isNaN(normalizedQuantity)) {
        return { ok: false, reason: "invalid" };
      }

      const res = await fetch(
        `${CONFIG.endpoints.portfolio}/${normalizedTicker}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quantity: normalizedQuantity,
            delta: Number.isFinite(normalizedDelta) ? normalizedDelta : 0.0,
            bucket,
          }),
        },
      );

      if (!res.ok) return { ok: false, reason: "server" };

      await load({ background: true });
      return { ok: true };
    },
    [load],
  );

  const addOrUpdate = useCallback(
    async ({ ticker, quantity, existingQuantity }) => {
      if (isUsingDemoData) return { ok: false, reason: "demo" };

      const t = normalizeTicker(ticker);
      const q = Number(quantity);
      if (!t || Number.isNaN(q)) return { ok: false, reason: "invalid" };

      if (existingQuantity != null) {
        const confirmed = window.confirm(
          `Ticker ${t} already exists with ${existingQuantity}. Update to ${q}?`,
        );
        if (!confirmed) return { ok: false, reason: "cancelled" };
      }

      return patchPortfolioPosition({
        ticker: t,
        quantity: q,
        delta: 0.0,
        bucket: CONFIG.defaultBucket,
      });
    },
    [isUsingDemoData, patchPortfolioPosition],
  );

  const setQuantity = useCallback(
    async ({
      ticker,
      quantity,
      delta = 0.0,
      bucket = CONFIG.defaultBucket,
    }) => {
      if (isUsingDemoData) return { ok: false, reason: "demo" };

      return patchPortfolioPosition({
        ticker,
        quantity,
        delta,
        bucket,
      });
    },
    [isUsingDemoData, patchPortfolioPosition],
  );

  const remove = useCallback(
    async ({ ticker }) => {
      if (isUsingDemoData) return { ok: false, reason: "demo" };

      const t = normalizeTicker(ticker);
      if (!t) return { ok: false, reason: "invalid" };

      const confirmed = window.confirm(
        `CONFIRM: Eliminate ${t} from portfolio?`,
      );
      if (!confirmed) return { ok: false, reason: "cancelled" };

      const res = await fetch(`${CONFIG.endpoints.portfolio}/${t}`, {
        method: "DELETE",
      });
      if (!res.ok) return { ok: false, reason: "server" };

      await load({ background: true });
      return { ok: true };
    },
    [isUsingDemoData, load],
  );

  const topTickers = useMemo(() => {
    return (
      [...rows]
        .sort(
          (a, b) => (Number(b.weight_pct) || 0) - (Number(a.weight_pct) || 0),
        )
        // TradingView ticker tape accepts plain tickers (no exchange prefix) and
        // resolves logos internally; keep them lowercase like the official snippet.
        .map((r) =>
          String(r?.ticker || "")
            .trim()
            .replace("-", ".")
            .toLowerCase(),
        )
        .filter(
          (t, i, self) =>
            t && t.length < CONFIG.maxTickerLength && self.indexOf(t) === i,
        )
        .slice(0, CONFIG.maxTickerTapeCount)
    );
  }, [rows]);

  return {
    rows,
    generatedAt,
    colorStandards,
    isLoading: loadingMode !== "idle",
    isBackgroundLoading: loadingMode === "background",
    isUsingDemoData,
    lastError,
    stats,
    topTickers,
    actions: {
      sync: load,
      addOrUpdate,
      setQuantity,
      remove,
    },
  };
}
