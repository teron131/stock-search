import { DAY_IN_MS, parseCacheTimestamp } from "../cache.js";
import { CONFIG } from "../config.js";
import { normalizeTicker } from "../format.js";

const RELEVANCE_SCORES = {
  high: 2,
  medium: 1,
  low: 0,
};

function normalizeDomain(rawDomain) {
  return String(rawDomain || "")
    .trim()
    .replace(/^www\./i, "")
    .toLowerCase();
}

function normalizeArticleUrl(url) {
  try {
    const normalizedUrl = new URL(url);
    return `${normalizedUrl.origin}${normalizedUrl.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(url || "")
      .trim()
      .toLowerCase();
  }
}

function createArticleKey(article) {
  const normalizedUrl = normalizeArticleUrl(article.url);
  if (normalizedUrl) {
    return normalizedUrl;
  }

  return [
    String(article.title || "")
      .trim()
      .toLowerCase(),
    String(article.date || "")
      .trim()
      .toLowerCase(),
  ]
    .filter(Boolean)
    .join("|");
}

function getPublishedTimestamp(article) {
  const publishedAt =
    article?.metadata?.published_at || article?.date || article?.metadata?.fetched_at;
  return parseCacheTimestamp(publishedAt) ?? 0;
}

function getFetchedTimestamp(article) {
  return parseCacheTimestamp(article?.metadata?.fetched_at) ?? 0;
}

function isExpiredTimestamp(timestamp, maxAgeMs, now) {
  return timestamp > 0 && now - timestamp > maxAgeMs;
}

function isRetainedNewsItem(article) {
  const now = Date.now();
  const fetchedTimestamp = getFetchedTimestamp(article);
  const publishedTimestamp = getPublishedTimestamp(article);
  const daysAgo = Number(article?.days_ago);
  const hasDaysAgo = Number.isFinite(daysAgo);

  if (isExpiredTimestamp(fetchedTimestamp, CONFIG.newsFetchedRetentionMs, now)) {
    return false;
  }

  if (isExpiredTimestamp(publishedTimestamp, CONFIG.newsPublishedRetentionMs, now)) {
    return false;
  }

  if (
    publishedTimestamp === 0 &&
    hasDaysAgo &&
    daysAgo * DAY_IN_MS > CONFIG.newsPublishedRetentionMs
  ) {
    return false;
  }

  return fetchedTimestamp > 0 || publishedTimestamp > 0 || hasDaysAgo;
}

export function pruneRetainedNewsItems(items) {
  return (Array.isArray(items) ? items : []).filter(isRetainedNewsItem);
}

export function sortNewsItems(items) {
  return [...items].sort((left, right) => {
    const timestampDiff = getPublishedTimestamp(right) - getPublishedTimestamp(left);
    if (timestampDiff !== 0) {
      return timestampDiff;
    }

    const relevanceDiff = RELEVANCE_SCORES[right.relevancy] - RELEVANCE_SCORES[left.relevancy];
    if (relevanceDiff !== 0) {
      return relevanceDiff;
    }

    return String(left.title || "").localeCompare(String(right.title || ""));
  });
}

export function getHeldTickers(rows) {
  const seen = new Set();
  const tickers = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const quantity = Number(row?.quantity);
    const ticker = normalizeTicker(row?.ticker);
    if (!ticker || quantity <= 0 || seen.has(ticker)) {
      continue;
    }
    seen.add(ticker);
    tickers.push(ticker);
  }

  return tickers;
}

export function mergeNewsItems(items) {
  const mergedItems = new Map();

  for (const item of items) {
    const articleKey = createArticleKey(item);
    const existingItem = mergedItems.get(articleKey);
    if (!existingItem) {
      mergedItems.set(articleKey, { ...item });
      continue;
    }

    const sourceTickers = Array.from(
      new Set(
        [
          ...(existingItem.sourceTickers || []),
          ...(item.sourceTickers || []),
          existingItem.sourceTicker,
          item.sourceTicker,
        ].filter(Boolean),
      ),
    );
    const preferredItem =
      getPublishedTimestamp(item) > getPublishedTimestamp(existingItem) ? item : existingItem;

    mergedItems.set(articleKey, {
      ...existingItem,
      ...preferredItem,
      summary:
        (item.summary || "").length > (existingItem.summary || "").length
          ? item.summary
          : existingItem.summary,
      relevancy:
        RELEVANCE_SCORES[item.relevancy] > RELEVANCE_SCORES[existingItem.relevancy]
          ? item.relevancy
          : existingItem.relevancy,
      sourceTicker: sourceTickers[0] || preferredItem.sourceTicker,
      sourceTickers,
      metadata: {
        ...existingItem.metadata,
        ...preferredItem.metadata,
        source_domain:
          normalizeDomain(preferredItem.metadata?.source_domain) ||
          normalizeDomain(existingItem.metadata?.source_domain) ||
          null,
      },
    });
  }

  return sortNewsItems(Array.from(mergedItems.values()));
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), items.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export function filterNewsItems(items, { tickerFilter, relevanceFilter }) {
  return items.filter((item) => {
    const matchesTicker =
      tickerFilter === "ALL" ||
      (item.sourceTickers || []).includes(tickerFilter) ||
      item.sourceTicker === tickerFilter;
    const matchesRelevance =
      relevanceFilter === "all" || (relevanceFilter === "high" && item.relevancy === "high");

    return matchesTicker && matchesRelevance;
  });
}

function normalizePortfolioNewsSummaryRequestRow(row) {
  return {
    ticker: normalizeTicker(row?.ticker),
    quantity: Number(row?.quantity),
    total: Number(row?.total),
    weight_pct: Number(row?.weight_pct),
  };
}

function normalizePortfolioNewsSummaryRequestItem(item) {
  return {
    title: item.title || null,
    summary: item.summary || "",
    relevancy: item.relevancy || "low",
    category: item.category || "other",
    sentiment: item.sentiment || "neutral",
    source_tickers: (item.sourceTickers || []).map(normalizeTicker).filter(Boolean),
  };
}

export function buildPortfolioNewsSummaryRequestPayload(rows, items) {
  return {
    rows: rows.map((row) => normalizePortfolioNewsSummaryRequestRow(row)),
    items: items.map((item) => normalizePortfolioNewsSummaryRequestItem(item)),
  };
}

export function mergePortfolioNewsSummaryWithFallback(
  portfolioNewsSummary,
  fallbackPortfolioNewsSummary,
) {
  if (!portfolioNewsSummary) {
    return fallbackPortfolioNewsSummary;
  }
  if (!fallbackPortfolioNewsSummary) {
    return portfolioNewsSummary;
  }

  return {
    ...portfolioNewsSummary,
    hasNews: portfolioNewsSummary.hasNews || fallbackPortfolioNewsSummary.hasNews,
    macros:
      portfolioNewsSummary.macros.length > 0
        ? portfolioNewsSummary.macros
        : fallbackPortfolioNewsSummary.macros,
    topTickers:
      portfolioNewsSummary.topTickers.length > 0
        ? portfolioNewsSummary.topTickers
        : fallbackPortfolioNewsSummary.topTickers,
  };
}

export function preserveVisiblePortfolioNewsSummary(
  portfolioNewsSummary,
  previousPortfolioNewsSummary,
) {
  if (!portfolioNewsSummary) {
    return previousPortfolioNewsSummary;
  }
  if (!previousPortfolioNewsSummary) {
    return portfolioNewsSummary;
  }

  const nextPortfolioNewsSummary = {
    ...portfolioNewsSummary,
    macros:
      portfolioNewsSummary.macros.length > 0
        ? portfolioNewsSummary.macros
        : previousPortfolioNewsSummary.macros,
  };
  return JSON.stringify(nextPortfolioNewsSummary) === JSON.stringify(previousPortfolioNewsSummary)
    ? previousPortfolioNewsSummary
    : nextPortfolioNewsSummary;
}
