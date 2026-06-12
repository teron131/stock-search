import { html } from "htm/react";
import { useMemo, useState } from "react";

const FACET_KEYS = ["relevancies", "categories", "sentiments", "labels"];

function toTimestamp(article) {
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

function formatRelativeTime(article) {
	const timestamp = toTimestamp(article);
	if (!timestamp) {
		return "--";
	}

	const diffMs = Date.now() - timestamp;
	const diffMinutes = Math.round(diffMs / 60_000);
	if (diffMinutes < 60) {
		return `${Math.max(diffMinutes, 1)}m ago`;
	}

	const diffHours = Math.round(diffMinutes / 60);
	if (diffHours < 24) {
		return `${diffHours}h ago`;
	}

	const diffDays = Math.round(diffHours / 24);
	if (diffDays < 7) {
		return `${diffDays}d ago`;
	}

	return new Date(timestamp).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});
}

function formatCategory(category) {
	return String(category || "other")
		.replace(/_/g, " ")
		.toUpperCase();
}

function formatSentiment(sentiment) {
	return String(sentiment || "neutral").toUpperCase();
}

function formatLabel(label) {
	return String(label || "")
		.replace(/_/g, " ")
		.toUpperCase();
}

function formatDomain(article) {
	return (
		String(article?.metadata?.source_domain || "")
			.trim()
			.replace(/^www\./i, "")
			.toUpperCase() || "SOURCE"
	);
}

function getRelevanceTone(relevancy) {
	if (relevancy === "high") {
		return "is-high";
	}
	if (relevancy === "medium") {
		return "is-medium";
	}
	return "is-low";
}

function getSentimentTone(sentiment) {
	if (sentiment === "bullish") {
		return "is-bullish";
	}
	if (sentiment === "bearish") {
		return "is-bearish";
	}
	return "is-neutral";
}

function normalizedList(values, fallbackValue) {
	const sourceValues = Array.isArray(values)
		? values
		: fallbackValue
			? [fallbackValue]
			: [];
	return Array.from(
		new Set(
			sourceValues.map((value) => String(value || "").trim()).filter(Boolean),
		),
	);
}

function collectStoryFacets(item) {
	return {
		relevancies: normalizedList(item.relevancies, item.relevancy),
		categories: normalizedList(item.categories, item.category),
		sentiments: normalizedList(item.sentiments, item.sentiment),
		labels: normalizedList(item.labels),
		status: String(item.status || "").trim(),
	};
}

function buildTickerFacetMap(items) {
	const facetMap = new Map();
	for (const item of items) {
		const tickers = normalizedList(item.sourceTickers, item.sourceTicker);
		if (tickers.length === 0) {
			continue;
		}
		const facets = collectStoryFacets(item);
		for (const ticker of tickers) {
			const existingFacets = facetMap.get(ticker) || {
				relevancies: new Set(),
				categories: new Set(),
				sentiments: new Set(),
				labels: new Set(),
			};
			for (const facetKey of FACET_KEYS) {
				for (const value of facets[facetKey]) {
					existingFacets[facetKey].add(value);
				}
			}
			facetMap.set(ticker, existingFacets);
		}
	}

	return new Map(
		Array.from(facetMap.entries()).map(([ticker, facets]) => [
			ticker,
			{
				relevancies: Array.from(facets.relevancies),
				categories: Array.from(facets.categories),
				sentiments: Array.from(facets.sentiments),
				labels: Array.from(facets.labels),
			},
		]),
	);
}

function buildNewsSignals({ items, heldTickers }) {
	const coveredTickers = new Set();
	let recentStoryCount = 0;
	let bullishCount = 0;
	let bearishCount = 0;

	for (const item of items) {
		const facets = collectStoryFacets(item);
		for (const ticker of normalizedList(
			item.sourceTickers,
			item.sourceTicker,
		)) {
			coveredTickers.add(ticker);
		}
		const daysAgo = Number(item.days_ago);
		const timestamp = toTimestamp(item);
		const isRecentByAge = Number.isFinite(daysAgo) && daysAgo <= 2;
		const isRecentByTimestamp =
			timestamp > 0 && Date.now() - timestamp <= 2 * 24 * 60 * 60 * 1000;
		if (isRecentByAge || isRecentByTimestamp) {
			recentStoryCount += 1;
		}
		if (facets.sentiments.includes("bullish")) {
			bullishCount += 1;
		}
		if (facets.sentiments.includes("bearish")) {
			bearishCount += 1;
		}
	}

	const storyCount = items.length;
	const sentimentCount = bullishCount + bearishCount;
	const coveragePct =
		heldTickers.length > 0
			? Math.round((coveredTickers.size / heldTickers.length) * 100)
			: 0;
	const recentStoryPct =
		storyCount > 0 ? Math.round((recentStoryCount / storyCount) * 100) : 0;
	const bullishPct =
		sentimentCount > 0 ? Math.round((bullishCount / sentimentCount) * 100) : 0;
	const bearishPct =
		sentimentCount > 0 ? Math.round((bearishCount / sentimentCount) * 100) : 0;
	const toneSkewPct = bullishPct - bearishPct;

	return {
		coveragePct,
		recentStoryPct,
		toneSkewPct,
	};
}

function renderPulseScale({ label, value, tone, caption }) {
	const boundedValue = Math.max(0, Math.min(100, Math.abs(Number(value) || 0)));
	const displayValue =
		tone === "mixed" && value > 0 ? `+${value}%` : `${value}%`;

	return html`
		<div
			key=${label}
			className=${`news-pulse-scale ${tone ? `is-${tone}` : ""}`}
			style=${{ "--news-pulse-value": `${boundedValue}%` }}
		>
			<div className="news-pulse-row">
				<span className="news-pulse-label">${label}</span>
				<span className="news-pulse-value">${displayValue}</span>
			</div>
			<div className="news-pulse-track" aria-hidden="true">
				<div className="news-pulse-fill"></div>
			</div>
			<div className="news-pulse-caption">${caption}</div>
		</div>
	`;
}

function renderSignalStrip(signals) {
	const toneLabel =
		signals.toneSkewPct > 0
			? "bullish skew"
			: signals.toneSkewPct < 0
				? "bearish skew"
				: "balanced tone";
	const pulseItems = [
		{
			label: "Coverage",
			value: signals.coveragePct,
			caption: "held tickers with news",
		},
		{
			label: "Recency",
			value: signals.recentStoryPct,
			tone: "high",
			caption: "published within 2 days",
		},
		{
			label: "Tone",
			value: signals.toneSkewPct,
			tone: signals.toneSkewPct < 0 ? "bearish" : "mixed",
			caption: toneLabel,
		},
	];

	return html`
		<section className="news-pulse-strip" aria-label="Portfolio news pulse">
			${pulseItems.map((item) => renderPulseScale(item))}
		</section>
	`;
}

function ControlSelect({ label, value, options, onChange }) {
	const [isOpen, setIsOpen] = useState(false);
	const selectedOption =
		options.find((option) => option.value === value) || options[0];

	return html`
		<div
			className="news-control"
			onBlur=${(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) {
					setIsOpen(false);
				}
			}}
		>
			<span className="news-control-label">${label}</span>
			<button
				type="button"
				className="news-control-select"
				aria-haspopup="listbox"
				aria-expanded=${isOpen ? "true" : "false"}
				onClick=${() => setIsOpen((currentValue) => !currentValue)}
			>
				<span>${selectedOption?.label || value}</span>
				<span className="news-control-arrow" aria-hidden="true"></span>
			</button>
			${
				isOpen
					? html`
						<div className="news-control-menu" role="listbox">
							${options.map(
								(option) => html`
									<button
										key=${option.value}
										type="button"
										className=${`news-control-option ${option.value === value ? "is-selected" : ""}`}
										role="option"
										aria-selected=${option.value === value ? "true" : "false"}
										onClick=${() => {
											onChange(option.value);
											setIsOpen(false);
										}}
									>
										${option.label}
									</button>
								`,
							)}
						</div>
					`
					: null
			}
		</div>
	`;
}

function formatWeight(weightPct) {
	const numericWeight = Number(weightPct);
	if (!Number.isFinite(numericWeight) || numericWeight <= 0) {
		return "--";
	}
	if (numericWeight < 0.5) {
		return "<1%";
	}
	if (numericWeight < 10) {
		return `${numericWeight.toFixed(1)}%`;
	}
	return `${Math.round(numericWeight)}%`;
}

function escapeRegex(text) {
	return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderHighlightedText(text, tickers) {
	const content = String(text || "");
	const normalizedTickers = Array.from(
		new Set(
			(tickers || [])
				.map((ticker) => String(ticker || "").trim())
				.filter(Boolean),
		),
	).sort((left, right) => right.length - left.length);
	if (!content || normalizedTickers.length === 0) {
		return content;
	}

	const tickerPattern = new RegExp(
		`(${normalizedTickers.map((ticker) => escapeRegex(ticker)).join("|")})`,
		"g",
	);
	const parts = content.split(tickerPattern);
	if (parts.length === 1) {
		return content;
	}

	const tickerSet = new Set(normalizedTickers);
	return parts.map((part, index) =>
		tickerSet.has(part)
			? html`<strong key=${`${part}-${index}`} className="news-inline-ticker">${part}</strong>`
			: part,
	);
}

function renderSummaryChapters(chapters) {
	const safeChapters = Array.isArray(chapters) ? chapters.filter(Boolean) : [];
	if (safeChapters.length === 0) {
		return null;
	}

	return html`
		<div className="news-summary-list">
			${safeChapters.map(
				(chapter, index) => html`
					<div
						key=${`${chapter.headline || "chapter"}-${index}`}
						className="news-summary-item"
					>
						<div className="news-summary-item-topic">${chapter.headline}</div>
						<div className="news-summary-item-text">
							${renderHighlightedText(
								chapter.paragraph,
								chapter.relatedTickers,
							)}
						</div>
					</div>
				`,
			)}
		</div>
	`;
}

function renderFacetTags(item, { compact = false } = {}) {
	const facets = collectStoryFacets(item);
	const labelLimit = compact ? 4 : 7;
	const categoryLimit = compact ? 2 : 4;
	const hiddenLabelCount = Math.max(facets.labels.length - labelLimit, 0);
	const tags = [
		...facets.relevancies.map((relevancy) => ({
			key: `relevancy-${relevancy}`,
			label: String(relevancy).toUpperCase(),
			className: `news-story-tag ${getRelevanceTone(relevancy)}`,
		})),
		...facets.categories.slice(0, categoryLimit).map((category) => ({
			key: `category-${category}`,
			label: formatCategory(category),
			className: "news-story-tag",
		})),
		...facets.sentiments.map((sentiment) => ({
			key: `sentiment-${sentiment}`,
			label: formatSentiment(sentiment),
			className: `news-story-tag ${getSentimentTone(sentiment)}`,
		})),
		...facets.labels.slice(0, labelLimit).map((label) => ({
			key: `label-${label}`,
			label: formatLabel(label),
			className: "news-story-tag news-story-label",
		})),
	];
	if (hiddenLabelCount > 0) {
		tags.push({
			key: "labels-more",
			label: `+${hiddenLabelCount}`,
			className: "news-story-tag news-story-label",
		});
	}
	if (facets.status && facets.status !== "fresh") {
		tags.unshift({
			key: `status-${facets.status}`,
			label: formatLabel(facets.status),
			className: "news-story-tag is-status",
		});
	}

	return tags.map(
		(tag) =>
			html`<span key=${tag.key} className=${tag.className}>${tag.label}</span>`,
	);
}

export function NewsView({
	items,
	portfolioNewsSummary,
	tickerFilter,
	setTickerFilter,
	relevanceFilter,
	setRelevanceFilter,
	heldTickers,
	failedTickers,
	isLoading,
	isRefreshing,
	isWaitingOnPortfolio,
	lastError,
}) {
	const [expandedArticleKeys, setExpandedArticleKeys] = useState(
		() => new Set(),
	);
	const hasItems = items.length > 0;
	const hasHoldings = heldTickers.length > 0;
	const hasMacroItems = (portfolioNewsSummary?.macros || []).length > 0;
	const tickerFacetMap = useMemo(() => buildTickerFacetMap(items), [items]);
	const newsSignals = useMemo(
		() => buildNewsSignals({ items, heldTickers }),
		[heldTickers, items],
	);
	const showFeedLoadingState =
		!isWaitingOnPortfolio && hasHoldings && !hasItems && isLoading;
	const coverageText =
		isLoading && !hasItems
			? "Refreshing portfolio news..."
			: `${items.length} stories across ${heldTickers.length} held tickers`;
	const summaryPlaceholderTitle = !hasHoldings
		? "Pulse unavailable"
		: isLoading
			? "Pulse pending"
			: "Pulse unavailable";
	const summaryPlaceholderCopy = !hasHoldings
		? "Add held positions to populate the portfolio news pulse."
		: isLoading
			? "Refreshing the held-position feed."
			: "Load the feed or sync again to populate this panel.";

	const toggleExpanded = (articleKey) => {
		setExpandedArticleKeys((currentKeys) => {
			const nextKeys = new Set(currentKeys);
			if (nextKeys.has(articleKey)) {
				nextKeys.delete(articleKey);
			} else {
				nextKeys.add(articleKey);
			}
			return nextKeys;
		});
	};

	return html`
		<div className="news-view">
			<section className="news-toolbar">
				<div className="news-toolbar-copy">
					<div className="sector-section-label">Portfolio News</div>
					<div className="news-toolbar-heading">
						<h2 className="news-toolbar-title">Held Positions</h2>
						<div className="news-toolbar-status">
							${coverageText}
							${
								isRefreshing
									? html`
										<span className="news-toolbar-note">Background refresh</span>
									`
									: null
							}
							${
								failedTickers.length > 0
									? html`
										<span className="news-toolbar-note">
											${failedTickers.length} ticker${failedTickers.length === 1 ? "" : "s"} unavailable
										</span>
									`
									: null
							}
						</div>
					</div>
				</div>

				<div className="news-controls">
					<${ControlSelect}
						label="Tickers"
						value=${tickerFilter}
						options=${[
							{ value: "ALL", label: "ALL HELD" },
							...heldTickers.map((ticker) => ({
								value: ticker,
								label: ticker,
							})),
						]}
						onChange=${setTickerFilter}
					/>

					<${ControlSelect}
						label="Signal"
						value=${relevanceFilter}
						options=${[
							{ value: "all", label: "ALL SIGNAL" },
							{ value: "high", label: "HIGH ONLY" },
						]}
						onChange=${setRelevanceFilter}
					/>
				</div>
			</section>
			${renderSignalStrip(newsSignals)}

			<section className="news-workspace-shell">
				<div className="news-summary-panel">
					<div className="news-panel-header">
						<div className="sector-section-label">Portfolio pulse</div>
					</div>
					${
						portfolioNewsSummary?.hasNews
							? html`
								<div className="news-summary-body">
									${
										hasMacroItems
											? html`
												<div className="news-summary-section is-macros">
													<div className="news-summary-title">Market drivers</div>
													${renderSummaryChapters(portfolioNewsSummary.macros)}
												</div>
											`
											: null
									}

									<div className="news-summary-section is-top-tickers">
										<div className="news-summary-title">Positions</div>
										<div className="news-ticker-briefs">
											${portfolioNewsSummary.topTickers.map((summaryItem) => {
												const tickerFacets = tickerFacetMap.get(
													summaryItem.ticker,
												);
												const weightLabel =
													summaryItem.weightLabel ||
													formatWeight(summaryItem.weightPct);
												return html`
														<article
															key=${summaryItem.ticker}
															className="news-ticker-brief"
														>
															<div className="news-ticker-brief-header">
																<div className="news-ticker-brief-ticker">
																	${summaryItem.ticker}
																</div>
																${
																	weightLabel !== "--"
																		? html`
																			<div className="news-ticker-brief-weight">
																				${weightLabel}
																			</div>
																		`
																		: null
																}
															</div>
															${
																tickerFacets
																	? html`
																		<div className="news-ticker-brief-facets">
																			${renderFacetTags(tickerFacets, { compact: true })}
																		</div>
																	`
																	: null
															}
															${renderSummaryChapters(summaryItem.chapters)}
														</article>
													`;
											})}
										</div>
									</div>
								</div>
							`
							: html`
								<div className="news-summary-body news-summary-placeholder">
									<div className="news-summary-title">${summaryPlaceholderTitle}</div>
									<div className="news-summary-copy">
										${summaryPlaceholderCopy}
									</div>
								</div>
							`
					}
				</div>

				<div className="news-list-panel">
					<div className="news-panel-header">
						<div className="sector-section-label">Portfolio News Feed</div>
						<div className="news-panel-title">Latest Coverage</div>
					</div>

					${
						isWaitingOnPortfolio
							? html`
								<div className="news-empty-state">
									<div className="news-empty-title">Loading portfolio scope</div>
									<div className="news-empty-copy">
										Preparing the held-position set before the portfolio news feed comes online.
									</div>
								</div>
							`
							: null
					}

					${
						showFeedLoadingState
							? html`
								<div className="news-empty-state">
									<div className="news-empty-title">Loading latest coverage</div>
									<div className="news-empty-copy">
										Refreshing the portfolio news feed for the held-position set.
									</div>
								</div>
							`
							: null
					}

					${
						!isWaitingOnPortfolio && !hasHoldings && !isLoading
							? html`
								<div className="news-empty-state">
									<div className="news-empty-title">No held positions in scope</div>
									<div className="news-empty-copy">
										Add a portfolio position to populate the portfolio news feed.
									</div>
								</div>
							`
							: null
					}

					${
						!showFeedLoadingState &&
						!isWaitingOnPortfolio &&
						hasHoldings &&
						!hasItems &&
						!isLoading
							? html`
								<div className="news-empty-state">
									<div className="news-empty-title">
										${lastError ? "News feed unavailable" : "No stories in scope"}
									</div>
									<div className="news-empty-copy">
										${
											lastError
												? "The current feed could not be loaded for the held-position set. Try syncing again."
												: "Try widening the ticker or relevance filter."
										}
									</div>
								</div>
							`
							: null
					}

					${
						hasItems
							? html`
								<div className="news-list">
									${items.map((item) => {
										const articleKey = item.url;
										const summary =
											item.summary || "No article note available.";
										const canToggleSummary =
											String(summary || "").trim().length > 160;
										const isExpanded = expandedArticleKeys.has(articleKey);
										return html`
											<article
												key=${articleKey}
												className=${`news-story-row ${isExpanded ? "is-expanded" : ""}`}
												onClick=${() => toggleExpanded(articleKey)}
												onKeyDown=${(event) => {
													if (event.key === "Enter" || event.key === " ") {
														event.preventDefault();
														toggleExpanded(articleKey);
													}
												}}
												role="button"
												tabIndex="0"
												aria-expanded=${isExpanded ? "true" : "false"}
											>
												<div className="news-story-topline">
													<div className="news-story-tickers">
														${(item.sourceTickers || []).map(
															(ticker) =>
																html`<span key=${ticker} className="news-ticker-pill">${ticker}</span>`,
														)}
													</div>
													<div className="news-story-meta-cluster">
														<span className="news-story-source">${formatDomain(item)}</span>
														<span className="news-story-age">${formatRelativeTime(item)}</span>
													</div>
												</div>

												<div className="news-story-body">
													<div className="news-story-headline">${item.title}</div>
													<div
														className=${`news-story-summary ${isExpanded ? "is-expanded" : ""}`}
													>
														${renderHighlightedText(summary, item.sourceTickers)}
													</div>
													${
														canToggleSummary
															? html`
																<div className="news-story-summary-actions">
																	<button
																		type="button"
																		className="news-story-toggle"
																		onClick=${(event) => {
																			event.stopPropagation();
																			toggleExpanded(articleKey);
																		}}
																	>
																		${isExpanded ? "COLLAPSE" : "EXPAND"}
																	</button>
																</div>
															`
															: null
													}
												</div>
												${
													isExpanded
														? html`
															<div className="news-story-expanded-actions">
																<a
																	className="btn btn-secondary news-open-btn"
																	href=${item.url}
																	target="_blank"
																	rel="noreferrer"
																	onClick=${(event) => event.stopPropagation()}
																>
																	OPEN SOURCE
																</a>
															</div>
														`
														: null
												}

												<div className="news-story-footer">
													${renderFacetTags(item)}
												</div>
											</article>
										`;
									})}
								</div>
							`
							: null
					}
				</div>
			</section>
		</div>
	`;
}
