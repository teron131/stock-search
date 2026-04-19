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
const NEWS_SENTIMENT_LEVELS = new Set(["bullish", "neutral", "bearish"]);

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

export function normalizeIndustryPayload(payload) {
	if (!payload || typeof payload !== "object") {
		return null;
	}

	const industries = Array.isArray(payload.industries)
		? payload.industries.filter(
				(industry) => industry && typeof industry === "object",
			)
		: null;
	if (!industries) {
		return null;
	}

	const meta =
		payload.meta && typeof payload.meta === "object" ? payload.meta : {};

	return {
		industries: industries.map((industry) => ({ ...industry })),
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
			industry_count: Number(meta.industry_count) || 0,
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
