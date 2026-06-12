import { normalizeTicker } from "./format.js";

const NEWS_RELEVANCY_LEVELS = new Set(["high", "medium", "low"]);
const NEWS_CATEGORY_LEVELS = new Set([
	"macro_economics",
	"industry_news",
	"market_news",
	"company_news",
	"earnings",
	"analyst_rating",
	"analysis",
	"other",
]);
const SUMMARY_RELEVANCY_LEVELS = new Set(["high", "medium"]);
const TICKER_SUMMARY_CATEGORY_LEVELS = new Set([
	...NEWS_CATEGORY_LEVELS,
	"rates",
	"inflation",
	"fed_policy",
	"geopolitics",
	"regulation",
	"fx",
	"oil_energy",
	"ai_capex",
	"data_center_power",
	"supply_chain",
	"demand",
	"pricing",
	"margins",
	"valuation",
	"capital_allocation",
	"guidance",
]);
const NEWS_SENTIMENT_LEVELS = new Set(["bullish", "neutral", "bearish"]);

function readArrayProperty(payload, snakeKey, camelKey) {
	if (Array.isArray(payload?.[snakeKey])) {
		return payload[snakeKey];
	}
	if (Array.isArray(payload?.[camelKey])) {
		return payload[camelKey];
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

export function normalizeApiDashboardPayload(payload) {
	const normalized = normalizeDashboardRowsPayload(payload);
	if (!normalized) return null;
	return normalized;
}

export function normalizeSectorPayload(payload) {
	if (!payload || typeof payload !== "object") {
		return null;
	}

	const sectors = Array.isArray(payload.sectors)
		? payload.sectors.filter((sector) => sector && typeof sector === "object")
		: null;
	if (!sectors) {
		return null;
	}

	const meta =
		payload.meta && typeof payload.meta === "object" ? payload.meta : {};

	return {
		sectors: sectors.map((sector) => ({ ...sector })),
		meta: {
			source:
				typeof meta.source === "string" && meta.source
					? meta.source
					: "stockanalysis",
			fetched_at:
				typeof meta.fetched_at === "string" && meta.fetched_at
					? meta.fetched_at
					: null,
			sector_count: Number(meta.sector_count) || 0,
		},
	};
}

function normalizeNewsMetadata(metadata) {
	if (!metadata || typeof metadata !== "object") {
		return {};
	}

	return {
		provider:
			typeof metadata.provider === "string" && metadata.provider
				? metadata.provider
				: null,
		source_domain:
			typeof metadata.source_domain === "string" && metadata.source_domain
				? metadata.source_domain
				: null,
		published_at:
			typeof metadata.published_at === "string" && metadata.published_at
				? metadata.published_at
				: null,
		fetched_at:
			typeof metadata.fetched_at === "string" && metadata.fetched_at
				? metadata.fetched_at
				: null,
	};
}

function normalizeNewsArticle(article, sourceTicker) {
	if (!article || typeof article !== "object") {
		return null;
	}

	const url =
		typeof article.url === "string" && article.url.trim()
			? article.url.trim()
			: null;
	if (!url) {
		return null;
	}

	return {
		url,
		title:
			typeof article.title === "string" && article.title.trim()
				? article.title.trim()
				: url,
		date:
			typeof article.date === "string" && article.date.trim()
				? article.date.trim()
				: null,
		days_ago: Number.isFinite(Number(article.days_ago))
			? Number(article.days_ago)
			: null,
		summary: typeof article.summary === "string" ? article.summary.trim() : "",
		relevancy: NEWS_RELEVANCY_LEVELS.has(article.relevancy)
			? article.relevancy
			: "low",
		category: NEWS_CATEGORY_LEVELS.has(article.category)
			? article.category
			: "other",
		sentiment: NEWS_SENTIMENT_LEVELS.has(article.sentiment)
			? article.sentiment
			: "neutral",
		metadata: normalizeNewsMetadata(article.metadata),
		sourceTicker,
		sourceTickers: sourceTicker ? [sourceTicker] : [],
	};
}

export function normalizeTickerNewsPayload(payload, sourceTicker) {
	if (!Array.isArray(payload)) {
		return [];
	}

	return payload
		.map((article) => normalizeNewsArticle(article, sourceTicker))
		.filter(Boolean);
}

export function normalizeDemoNewsPayload(payload) {
	if (!payload || typeof payload !== "object") {
		return null;
	}

	const rawItemsByTicker =
		payload.items_by_ticker && typeof payload.items_by_ticker === "object"
			? payload.items_by_ticker
			: null;
	if (!rawItemsByTicker) {
		return null;
	}

	return {
		meta:
			payload.meta && typeof payload.meta === "object"
				? {
						generated_at:
							typeof payload.meta.generated_at === "string" &&
							payload.meta.generated_at
								? payload.meta.generated_at
								: null,
					}
				: { generated_at: null },
		items_by_ticker: Object.fromEntries(
			Object.entries(rawItemsByTicker).map(([ticker, articles]) => {
				const normalizedTicker = normalizeTicker(ticker);
				return [
					normalizedTicker,
					normalizeTickerNewsPayload(articles, normalizedTicker),
				];
			}),
		),
	};
}

function normalizePortfolioNewsSummaryChapter(chapter) {
	if (!chapter || typeof chapter !== "object") {
		return null;
	}

	const headline =
		typeof chapter.headline === "string" && chapter.headline.trim()
			? chapter.headline.trim()
			: null;
	const paragraph =
		typeof chapter.paragraph === "string" && chapter.paragraph.trim()
			? chapter.paragraph.trim()
			: null;
	if (!headline || !paragraph) {
		return null;
	}

	const rawRelatedTickers = Array.isArray(chapter.tickers)
		? chapter.tickers
		: readArrayProperty(chapter, "related_tickers", "relatedTickers");
	const relatedTickers = rawRelatedTickers.map(normalizeTicker).filter(Boolean);

	return {
		headline,
		paragraph,
		relatedTickers,
	};
}

function normalizeTickerNewsSummary(item) {
	if (!item || typeof item !== "object") {
		return null;
	}

	const ticker = normalizeTicker(item.ticker);
	const summary =
		typeof item.summary === "string" && item.summary.trim()
			? item.summary.trim()
			: null;
	if (!ticker || !summary) {
		return null;
	}

	const headline =
		typeof item.headline === "string" && item.headline.trim()
			? item.headline.trim()
			: `${ticker} news`;
	const sourceUrls = normalizeTextList(
		readArrayProperty(item, "source_urls", "sourceUrls"),
	);
	const relevancies = normalizeEnumList({
		values: item.relevancies,
		fallbackValue: item.relevancy,
		allowedValues: SUMMARY_RELEVANCY_LEVELS,
		defaultValue: "medium",
	});
	const categories = normalizeEnumList({
		values: item.categories,
		fallbackValue: item.category,
		allowedValues: TICKER_SUMMARY_CATEGORY_LEVELS,
		defaultValue: "other",
	});
	const labels = normalizeTextList(item.labels);
	const sentiments = normalizeEnumList({
		values: item.sentiments,
		fallbackValue: item.sentiment,
		allowedValues: NEWS_SENTIMENT_LEVELS,
		defaultValue: "neutral",
	});

	return {
		ticker,
		headline,
		summary,
		relevancies,
		categories,
		labels,
		sentiments,
		relevancy: preferredRelevancy(relevancies),
		category: categories[0] || "other",
		sentiment: preferredSentiment(sentiments),
		sourceUrls,
		status:
			typeof item.status === "string" && item.status ? item.status : "fresh",
	};
}

function articleFromTickerSummary(item, generatedAt) {
	const url = item.sourceUrls[0] || `stock-search:news-summary:${item.ticker}`;
	return {
		url,
		title: item.headline,
		date: generatedAt,
		days_ago: null,
		summary: item.summary,
		relevancies: item.relevancies,
		relevancy: item.relevancy,
		categories: item.categories,
		category: item.category,
		labels: item.labels,
		sentiments: item.sentiments,
		sentiment: item.sentiment,
		status: item.status,
		metadata: {
			provider: "external-agent",
			source_domain: item.sourceUrls.length > 0 ? null : "portfolio-news",
			published_at: generatedAt,
			fetched_at: generatedAt,
		},
		sourceTicker: item.ticker,
		sourceTickers: [item.ticker],
	};
}

function summaryFromTickerSummaries(tickerSummaries) {
	if (tickerSummaries.length === 0) {
		return null;
	}

	return {
		hasNews: true,
		macros: [],
		topTickers: tickerSummaries.map((item) => ({
			ticker: item.ticker,
			weightPct: 0,
			weightLabel: null,
			chapters: [
				{
					headline: item.headline,
					paragraph: item.summary,
					relatedTickers: [item.ticker],
				},
			],
		})),
	};
}

function normalizeTextList(values) {
	if (!Array.isArray(values)) {
		return [];
	}
	return Array.from(
		new Set(values.map((value) => String(value || "").trim()).filter(Boolean)),
	);
}

function normalizeEnumList({
	values,
	fallbackValue,
	allowedValues,
	defaultValue,
}) {
	const sourceValues = Array.isArray(values)
		? values
		: typeof fallbackValue === "string"
			? [fallbackValue]
			: [];
	const normalizedValues = Array.from(
		new Set(
			sourceValues
				.map((value) => String(value || "").trim())
				.filter((value) => allowedValues.has(value)),
		),
	);
	return normalizedValues.length > 0 ? normalizedValues : [defaultValue];
}

function preferredRelevancy(relevancies) {
	if (relevancies.includes("high")) {
		return "high";
	}
	if (relevancies.includes("medium")) {
		return "medium";
	}
	return "low";
}

function preferredSentiment(sentiments) {
	if (sentiments.includes("bearish") && sentiments.includes("bullish")) {
		return "neutral";
	}
	if (sentiments.includes("bullish")) {
		return "bullish";
	}
	if (sentiments.includes("bearish")) {
		return "bearish";
	}
	return "neutral";
}

export function normalizePortfolioNewsSummaryPayload(payload) {
	if (!payload || typeof payload !== "object") {
		return null;
	}

	const rawTopTickers = Array.isArray(payload.top_tickers)
		? payload.top_tickers
		: Array.isArray(payload.topTickers)
			? payload.topTickers
			: [];

	return {
		hasNews:
			typeof payload.has_news === "boolean"
				? payload.has_news
				: Boolean(payload.hasNews),
		macros: Array.isArray(payload.macros)
			? payload.macros.map(normalizePortfolioNewsSummaryChapter).filter(Boolean)
			: [],
		topTickers: rawTopTickers
			.filter((item) => item && typeof item === "object")
			.map((item) => ({
				ticker: normalizeTicker(item.ticker),
				weightPct: Number.isFinite(Number(item.weight_pct))
					? Number(item.weight_pct)
					: Number.isFinite(Number(item.weightPct))
						? Number(item.weightPct)
						: 0,
				weightLabel:
					typeof item.weightLabel === "string" && item.weightLabel.trim()
						? item.weightLabel.trim()
						: null,
				chapters: Array.isArray(item.chapters)
					? item.chapters
							.map(normalizePortfolioNewsSummaryChapter)
							.filter(Boolean)
					: [],
			}))
			.filter((item) => item.ticker),
	};
}

export function normalizePortfolioNewsPayload(payload) {
	if (!payload || typeof payload !== "object") {
		return null;
	}

	const rawGroups = readArrayProperty(
		payload,
		"articles_by_ticker",
		"articlesByTicker",
	);
	const generatedAt =
		typeof payload.refreshed_at === "string" && payload.refreshed_at
			? payload.refreshed_at
			: typeof payload.refreshedAt === "string" && payload.refreshedAt
				? payload.refreshedAt
				: null;
	const tickerSummaries = readArrayProperty(
		payload,
		"ticker_summaries",
		"tickerSummaries",
	)
		.map(normalizeTickerNewsSummary)
		.filter(Boolean);
	const groups = rawGroups
		.filter((group) => group && typeof group === "object")
		.map((group) => {
			const ticker = normalizeTicker(group.ticker);
			return {
				ticker,
				status:
					typeof group.status === "string" && group.status
						? group.status
						: "fresh",
				articles: normalizeTickerNewsPayload(group.articles, ticker),
			};
		})
		.filter((group) => group.ticker);
	const summaryItems = tickerSummaries.map((item) =>
		articleFromTickerSummary(item, generatedAt),
	);
	const normalizedSummary = normalizePortfolioNewsSummaryPayload(
		payload.summary,
	);

	return {
		generatedAt,
		tickers: [
			...new Set([
				...groups.map((group) => group.ticker),
				...tickerSummaries.map((item) => item.ticker),
			]),
		],
		items: [...groups.flatMap((group) => group.articles), ...summaryItems],
		failedTickers: Array.from(
			new Set([
				...groups
					.filter((group) => group.status === "failed")
					.map((group) => group.ticker),
				...tickerSummaries
					.filter((item) => item.status === "failed")
					.map((item) => item.ticker),
			]),
		),
		portfolioNewsSummary:
			normalizedSummary || summaryFromTickerSummaries(tickerSummaries),
	};
}
