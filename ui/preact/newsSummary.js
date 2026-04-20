import { normalizeTicker } from "./format.js";

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
		article?.metadata?.published_at ||
		article?.date ||
		article?.metadata?.fetched_at;
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

function getHeldTickerRows(rows) {
	const heldRows = [];
	const seenTickers = new Set();
	const inputRows = Array.isArray(rows) ? rows : [];

	for (const row of inputRows) {
		const ticker = normalizeTicker(row?.ticker);
		const quantity = toFiniteNumber(row?.quantity);
		if (
			!ticker ||
			quantity == null ||
			quantity <= 0 ||
			seenTickers.has(ticker)
		) {
			continue;
		}

		seenTickers.add(ticker);
		heldRows.push({ ...row, ticker });
	}

	const totalValue = heldRows.reduce(
		(sum, row) => sum + (toFiniteNumber(row.total) || 0),
		0,
	);

	return heldRows
		.map((row) => {
			const weightPct = toFiniteNumber(row.weight_pct);
			if (weightPct != null && weightPct > 0) {
				return { ...row, weightPct };
			}

			const total = toFiniteNumber(row.total);
			return {
				...row,
				weightPct:
					totalValue > 0 && total != null && total > 0
						? (total / totalValue) * 100
						: 0,
			};
		})
		.sort((left, right) => right.weightPct - left.weightPct);
}

function summarizeArticle(article) {
	return normalizeText(article?.summary);
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

	return (
		categoryScore +
		relevanceScore +
		recencyScore +
		directTickerBonus +
		toneBonus
	);
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

function getLeadArticlesForTicker(items, ticker) {
	return dedupeArticlesBySummary(
		items
			.filter((article) => getArticleTickers(article).includes(ticker))
			.sort(
				(left, right) =>
					scoreTickerArticle(right, ticker) - scoreTickerArticle(left, ticker),
			),
	).slice(0, 2);
}

function getMacroArticles(items) {
	return dedupeArticlesBySummary(
		items
			.filter((article) => {
				const category = article?.category;
				return (
					category === "macro_economics" ||
					category === "market_news" ||
					category === "industry_news"
				);
			})
			.sort(
				(left, right) => scoreMacroArticle(right) - scoreMacroArticle(left),
			),
	).slice(0, 2);
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

function joinTickers(tickers) {
	if (tickers.length <= 1) {
		return tickers[0] || "";
	}
	if (tickers.length === 2) {
		return `${tickers[0]} and ${tickers[1]}`;
	}
	return `${tickers.slice(0, -1).join(", ")}, and ${tickers.at(-1)}`;
}

function describeSentiment(articles) {
	let weightedScore = 0;

	for (const article of articles) {
		const sentimentScore = SENTIMENT_SCORES[article?.sentiment] || 0;
		const relevanceScore = RELEVANCE_SCORES[article?.relevancy] || 0;
		weightedScore += sentimentScore * Math.max(relevanceScore, 1);
	}

	if (weightedScore >= 3) {
		return "constructive";
	}
	if (weightedScore <= -3) {
		return "pressured";
	}
	return "mixed";
}

function describeTickerCoverage(articles) {
	const categories = new Set(articles.map((article) => article?.category));
	if (
		categories.has("earnings") ||
		categories.has("company_news") ||
		categories.has("analyst_rating")
	) {
		return "Coverage is centered on company-specific developments.";
	}
	if (categories.has("industry_news")) {
		return "Coverage is leaning on industry read-through more than pure market noise.";
	}
	if (categories.has("macro_economics") || categories.has("market_news")) {
		return "Coverage is mostly macro and market spillover.";
	}
	return "Coverage is present, but the read-through is still broad rather than company-specific.";
}

function buildTickerSummary(row, items) {
	const leadArticles = getLeadArticlesForTicker(items, row.ticker);
	const weightLabel = formatWeight(row.weightPct);

	if (leadArticles.length === 0) {
		return {
			ticker: row.ticker,
			weightPct: row.weightPct,
			weightLabel,
			summary: `${row.ticker} is roughly ${weightLabel} of the portfolio, but the current feed is thin and does not yet add much beyond background context.`,
		};
	}

	const articleSummary = leadArticles
		.map((article) => summarizeArticle(article))
		.filter(Boolean)
		.join(" ");
	const coverage = describeTickerCoverage(leadArticles);
	const sentiment = describeSentiment(leadArticles);

	return {
		ticker: row.ticker,
		weightPct: row.weightPct,
		weightLabel,
		summary: `${row.ticker} is roughly ${weightLabel} of the portfolio. ${coverage} ${articleSummary} Overall tone is ${sentiment}.`,
	};
}

function buildOverview(heldRows, items, macroArticles) {
	const topHeldRows = heldRows.slice(0, 3);
	if (topHeldRows.length === 0) {
		return "No held positions are currently available for a portfolio-wide readout.";
	}

	const topTickerList = joinTickers(topHeldRows.map((row) => row.ticker));
	const topTickerWeight = topHeldRows.reduce(
		(sum, row) => sum + row.weightPct,
		0,
	);
	const tone = describeSentiment(
		topHeldRows.flatMap((row) => getLeadArticlesForTicker(items, row.ticker)),
	);

	if (macroArticles.length === 0) {
		return `${topTickerList} drive about ${Math.round(topTickerWeight)}% of the portfolio, so those holdings should dominate the tape. Shared macro coverage is light right now, and the feed is mostly being set by company and industry-specific updates. Overall tone is ${tone}.`;
	}

	return `${topTickerList} drive about ${Math.round(topTickerWeight)}% of the portfolio, so those holdings are setting the pace of the feed. The backdrop is not just ticker-specific: macro and market coverage is active enough to influence several names at once. Overall tone is ${tone}.`;
}

function buildMacroSummary(macroArticles) {
	if (macroArticles.length === 0) {
		return "Macro and market coverage is light right now, so the portfolio readout is being driven mainly by company-level and industry-level updates.";
	}

	const macroTickers = Array.from(
		new Set(macroArticles.flatMap((article) => getArticleTickers(article))),
	).slice(0, 4);
	const macroTickerText =
		macroTickers.length > 0
			? `Shared macro flow touching ${joinTickers(macroTickers)} is the main backdrop.`
			: "Shared macro flow is the main backdrop.";

	return `${macroTickerText} ${macroArticles
		.map((article) => summarizeArticle(article))
		.filter(Boolean)
		.join(" ")}`;
}

export function buildPortfolioNewsSummary({ rows, items }) {
	const heldRows = getHeldTickerRows(rows);
	if (heldRows.length === 0) {
		return null;
	}

	const sourceItems = Array.isArray(items) ? items : [];
	const topTickers = heldRows
		.slice(0, 5)
		.map((row) => buildTickerSummary(row, sourceItems));
	const macroArticles = getMacroArticles(sourceItems);

	return {
		hasNews: sourceItems.length > 0,
		overview: buildOverview(heldRows, sourceItems, macroArticles),
		macros: buildMacroSummary(macroArticles),
		topTickers,
	};
}
