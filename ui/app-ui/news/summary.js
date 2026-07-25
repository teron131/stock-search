import { normalizeTicker } from "../format.js";

const MAX_TOP_TICKERS = 5;
const MAX_SOURCE_ARTICLES = 2;
const MAX_CHAPTERS_PER_GROUP = 3;
const THIN_COVERAGE_HEADLINE = "Coverage Remains Thin";
const THIN_COVERAGE_PARAGRAPH = "Current feed does not surface a clear ticker-specific theme yet.";

const RELEVANCE_SCORES = {
  high: 3,
  medium: 2,
  low: 1,
};

const SENTIMENT_SCORES = {
  bullish: 1,
  neutral: 0,
  bearish: -1,
};

const TICKER_CATEGORY_SCORES = {
  earnings: 42,
  company_news: 38,
  analyst_rating: 34,
  analysis: 26,
  industry_news: 18,
  market_news: 12,
  macro_economics: 8,
  other: 6,
};

const MACRO_CATEGORY_SCORES = {
  macro_economics: 44,
  market_news: 36,
  industry_news: 24,
  analysis: 18,
  company_news: 10,
  earnings: 8,
  analyst_rating: 8,
  other: 4,
};

function toFiniteNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function getPublishedTimestamp(article) {
  const publishedAt =
    article?.metadata?.published_at || article?.date || article?.metadata?.fetched_at;
  if (!publishedAt) {
    return 0;
  }

  const timestamp = Date.parse(publishedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getRecencyScore(article) {
  const daysAgo = toFiniteNumber(article?.days_ago);
  if (daysAgo != null) {
    return Math.max(0, 5 - daysAgo);
  }

  const timestamp = getPublishedTimestamp(article);
  if (!timestamp) {
    return 0;
  }

  const diffHours = Math.max(0, (Date.now() - timestamp) / 3_600_000);
  if (diffHours <= 12) {
    return 5;
  }
  if (diffHours <= 24) {
    return 4;
  }
  if (diffHours <= 48) {
    return 3;
  }
  if (diffHours <= 72) {
    return 2;
  }
  return 1;
}

function getArticleTickers(article) {
  const tickers = new Set();

  for (const sourceTicker of article?.sourceTickers || []) {
    const normalizedTicker = normalizeTicker(sourceTicker);
    if (normalizedTicker) {
      tickers.add(normalizedTicker);
    }
  }

  const normalizedTicker = normalizeTicker(article?.sourceTicker);
  if (normalizedTicker) {
    tickers.add(normalizedTicker);
  }

  return Array.from(tickers);
}

function unionTickers(...tickerLists) {
  return Array.from(
    new Set(
      tickerLists.flatMap((tickerList) =>
        (tickerList || []).map((ticker) => normalizeTicker(ticker)).filter(Boolean),
      ),
    ),
  );
}

function getHeldTickerRows(rows) {
  const heldRows = [];
  const seenTickers = new Set();
  const inputRows = Array.isArray(rows) ? rows : [];

  for (const row of inputRows) {
    const ticker = normalizeTicker(row?.ticker);
    const quantity = toFiniteNumber(row?.quantity);
    if (!ticker || quantity == null || quantity <= 0 || seenTickers.has(ticker)) {
      continue;
    }

    seenTickers.add(ticker);
    heldRows.push({ ...row, ticker });
  }

  const totalValue = heldRows.reduce((sum, row) => sum + (toFiniteNumber(row.total) || 0), 0);

  return heldRows
    .map((row) => {
      const weightPct = toFiniteNumber(row.weight_pct);
      if (weightPct != null && weightPct > 0) {
        return { ...row, weightPct };
      }

      const total = toFiniteNumber(row.total);
      return {
        ...row,
        weightPct: totalValue > 0 && total != null && total > 0 ? (total / totalValue) * 100 : 0,
      };
    })
    .sort((left, right) => right.weightPct - left.weightPct);
}

function summarizeArticle(article) {
  return normalizeText(article?.summary);
}

function buildChapter(headline, paragraph, relatedTickers = []) {
  const normalizedHeadline = normalizeText(headline);
  const normalizedParagraph = normalizeText(paragraph);
  if (!normalizedHeadline || !normalizedParagraph) {
    return null;
  }

  return {
    headline: normalizedHeadline,
    paragraph: normalizedParagraph,
    relatedTickers: unionTickers(relatedTickers),
  };
}

function dedupeChapters(chapters) {
  const dedupedChapters = [];
  const seenKeys = new Set();

  for (const chapter of chapters) {
    if (!chapter) {
      continue;
    }

    const chapterKey = `${chapter.headline.toLowerCase()}|${chapter.paragraph.toLowerCase()}`;
    if (seenKeys.has(chapterKey)) {
      continue;
    }
    seenKeys.add(chapterKey);
    dedupedChapters.push(chapter);
  }

  return dedupedChapters;
}

function toHeadlineTitleCase(text) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word.length <= 3 ? word.toUpperCase() : `${word[0].toUpperCase()}${word.slice(1)}`,
    )
    .join(" ");
}

function chapterHeadlineFromArticle(article) {
  const rawTitle = normalizeText(article?.title);
  if (!rawTitle) {
    return "Market thread";
  }

  const baseTitle = rawTitle
    .replace(/\([A-Z.:-]{1,12}\)/g, "")
    .split(/[|:;-]/)[0]
    .replace(/\s+/g, " ")
    .trim();
  if (!baseTitle) {
    return "Market thread";
  }

  const words = baseTitle.split(" ").filter(Boolean).slice(0, 6);
  return toHeadlineTitleCase(words.join(" "));
}

function buildArticleChapter(article) {
  const summary = summarizeArticle(article);
  if (!summary) {
    return null;
  }

  return buildChapter(chapterHeadlineFromArticle(article), summary, getArticleTickers(article));
}

function scoreTickerArticle(article, ticker) {
  const sourceTickers = getArticleTickers(article);
  if (!sourceTickers.includes(ticker)) {
    return Number.NEGATIVE_INFINITY;
  }

  const categoryScore = TICKER_CATEGORY_SCORES[article?.category] || 0;
  const relevanceScore = (RELEVANCE_SCORES[article?.relevancy] || 0) * 14;
  const recencyScore = getRecencyScore(article) * 4;
  const directTickerBonus = sourceTickers.length === 1 ? 8 : 0;
  const toneBonus = Math.abs(SENTIMENT_SCORES[article?.sentiment] || 0) * 2;

  return categoryScore + relevanceScore + recencyScore + directTickerBonus + toneBonus;
}

function scoreMacroArticle(article) {
  const categoryScore = MACRO_CATEGORY_SCORES[article?.category] || 0;
  const relevanceScore = (RELEVANCE_SCORES[article?.relevancy] || 0) * 14;
  const recencyScore = getRecencyScore(article) * 4;
  const breadthBonus = Math.max(getArticleTickers(article).length - 1, 0) * 3;
  return categoryScore + relevanceScore + recencyScore + breadthBonus;
}

function dedupeArticlesBySummary(articles) {
  const seenSummaries = new Set();
  const dedupedArticles = [];

  for (const article of articles) {
    const summaryText = summarizeArticle(article);
    if (!summaryText || seenSummaries.has(summaryText)) {
      continue;
    }
    seenSummaries.add(summaryText);
    dedupedArticles.push(article);
  }

  return dedupedArticles;
}

function selectLeadArticles(items, { filter, score, limit = MAX_SOURCE_ARTICLES }) {
  return dedupeArticlesBySummary(
    items.filter(filter).sort((left, right) => score(right) - score(left)),
  ).slice(0, limit);
}

function getLeadArticlesForTicker(items, ticker) {
  return selectLeadArticles(items, {
    filter: (article) => getArticleTickers(article).includes(ticker),
    score: (article) => scoreTickerArticle(article, ticker),
  });
}

function getMacroArticles(items) {
  return selectLeadArticles(items, {
    filter: (article) => {
      const category = article?.category;
      return category === "macro_economics" || category === "market_news";
    },
    score: scoreMacroArticle,
  });
}

function formatWeight(weightPct) {
  if (weightPct < 0.5) {
    return "<1%";
  }
  if (weightPct < 10) {
    return `${weightPct.toFixed(1)}%`;
  }
  return `${Math.round(weightPct)}%`;
}

function buildThinCoverageChapter(ticker) {
  return buildChapter(THIN_COVERAGE_HEADLINE, THIN_COVERAGE_PARAGRAPH, [ticker]);
}

function buildChaptersFromArticles(articles) {
  return dedupeChapters(articles.map((article) => buildArticleChapter(article))).slice(
    0,
    MAX_CHAPTERS_PER_GROUP,
  );
}

function buildTickerSummary(row, items) {
  const leadArticles = getLeadArticlesForTicker(items, row.ticker);
  const weightLabel = formatWeight(row.weightPct);

  if (leadArticles.length === 0) {
    return {
      ticker: row.ticker,
      weightPct: row.weightPct,
      weightLabel,
      chapters: [buildThinCoverageChapter(row.ticker)],
    };
  }

  return {
    ticker: row.ticker,
    weightPct: row.weightPct,
    weightLabel,
    chapters: buildChaptersFromArticles(leadArticles),
  };
}

function buildMacroSummary(macroArticles) {
  if (macroArticles.length === 0) {
    return { chapters: [] };
  }

  return {
    chapters: buildChaptersFromArticles(macroArticles),
  };
}

export function buildPortfolioNewsSummary({ rows, items }) {
  const heldRows = getHeldTickerRows(rows);
  if (heldRows.length === 0) {
    return null;
  }

  const sourceItems = Array.isArray(items) ? items : [];
  const topTickers = heldRows
    .slice(0, MAX_TOP_TICKERS)
    .map((row) => buildTickerSummary(row, sourceItems));
  const macroArticles = getMacroArticles(sourceItems);
  const macros = buildMacroSummary(macroArticles);

  return {
    hasNews: sourceItems.length > 0,
    macros: macros.chapters || [],
    topTickers,
  };
}
