import {
  isCacheTimestampFresh,
  isSameLocalDay,
  readLocalStorageJson,
  writeLocalStorageJson,
} from "../cache.js";
import { CONFIG } from "../config.js";
import {
  normalizePortfolioNewsSummaryPayload,
  normalizeTickerNewsPayload,
} from "../dataContract.js";
import { mergeNewsItems, pruneRetainedNewsItems } from "./dataModel.js";

const STOCK_NEWS_CACHE_PREFIX = "stock-search:stock-news-cache";
const PORTFOLIO_NEWS_SUMMARY_CACHE_PREFIX = "stock-search:portfolio-news-summary-cache";

function getNewsCacheKey(ticker) {
  return `${STOCK_NEWS_CACHE_PREFIX}:${ticker}`;
}

function getPortfolioNewsSummaryCacheKey(heldTickerKey) {
  return `${PORTFOLIO_NEWS_SUMMARY_CACHE_PREFIX}:${heldTickerKey || "none"}`;
}

function readTickerNewsCache(ticker) {
  const parsedValue = readLocalStorageJson(getNewsCacheKey(ticker));
  const fetchedAt =
    typeof parsedValue?.fetched_at === "string" && parsedValue.fetched_at
      ? parsedValue.fetched_at
      : null;
  if (!fetchedAt) {
    return null;
  }

  return {
    ticker,
    fetchedAt,
    items: pruneRetainedNewsItems(normalizeTickerNewsPayload(parsedValue.items, ticker)),
  };
}

export function writeTickerNewsCache(ticker, items, fetchedAt) {
  writeLocalStorageJson(getNewsCacheKey(ticker), {
    fetched_at: fetchedAt,
    items: pruneRetainedNewsItems(items),
  });
}

export function isCacheFresh(fetchedAt) {
  return isCacheTimestampFresh(fetchedAt, CONFIG.stockNewsCacheTtlMs);
}

export function readPortfolioNewsSummaryCache(heldTickerKey) {
  const parsedValue = readLocalStorageJson(getPortfolioNewsSummaryCacheKey(heldTickerKey));
  const fetchedAt =
    typeof parsedValue?.fetched_at === "string" && parsedValue.fetched_at
      ? parsedValue.fetched_at
      : null;
  const portfolioNewsSummary = normalizePortfolioNewsSummaryPayload(parsedValue?.summary);
  if (!fetchedAt || !portfolioNewsSummary) {
    return null;
  }

  return { fetchedAt, portfolioNewsSummary };
}

export function writePortfolioNewsSummaryCache(heldTickerKey, portfolioNewsSummary, fetchedAt) {
  writeLocalStorageJson(getPortfolioNewsSummaryCacheKey(heldTickerKey), {
    fetched_at: fetchedAt,
    summary: portfolioNewsSummary,
  });
}

export function isPortfolioNewsSummaryFresh(fetchedAt) {
  if (isSameLocalDay(fetchedAt)) {
    return true;
  }

  return isCacheTimestampFresh(fetchedAt, CONFIG.portfolioNewsCacheTtlMs);
}

export function buildCacheSnapshot(heldTickers) {
  const cacheEntries = heldTickers.map((ticker) => readTickerNewsCache(ticker)).filter(Boolean);
  const cacheEntryMap = new Map(cacheEntries.map((entry) => [entry.ticker, entry]));

  return {
    cacheEntries,
    cacheEntryMap,
    items: mergeNewsItems(cacheEntries.flatMap((cacheEntry) => cacheEntry.items || [])),
    generatedAt:
      cacheEntries
        .map((cacheEntry) => cacheEntry.fetchedAt)
        .sort()
        .at(-1) || null,
  };
}
