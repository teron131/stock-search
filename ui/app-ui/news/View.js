import { html } from "htm/react";
import { useState } from "react";

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

function renderTickerPills(sourceTickers) {
	return (sourceTickers || []).map(
		(ticker) =>
			html`<span key=${ticker} className="news-ticker-pill">${ticker}</span>`,
	);
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

function shouldShowSummaryToggle(summary) {
	return String(summary || "").trim().length > 160;
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

function renderTickerBriefLabel(ticker) {
	return html`<div className="news-ticker-brief-ticker">${ticker}</div>`;
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
	const showFeedLoadingState =
		!isWaitingOnPortfolio && hasHoldings && !hasItems && isLoading;
	const coverageText =
		isLoading && !hasItems
			? "Refreshing portfolio news..."
			: `${items.length} stories across ${heldTickers.length} held tickers`;
	const summaryPlaceholderTitle = !hasHoldings
		? "Summary unavailable"
		: isLoading
			? "Summary pending"
			: "Summary unavailable";
	const summaryPlaceholderCopy = !hasHoldings
		? "Add held positions to generate the portfolio news summary."
		: isLoading
			? "Refreshing the held-position feed to generate the latest portfolio news summary."
			: "Load the feed or sync again to generate the portfolio news summary.";

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
					<label className="news-control">
						<span className="news-control-label">Tickers</span>
						<select
							className="news-control-select"
							value=${tickerFilter}
							onChange=${(event) => setTickerFilter(event.target.value)}
						>
							<option value="ALL">ALL HELD</option>
							${heldTickers.map(
								(ticker) =>
									html`<option key=${ticker} value=${ticker}>${ticker}</option>`,
							)}
						</select>
					</label>

					<label className="news-control">
						<span className="news-control-label">Relevance</span>
						<select
							className="news-control-select"
							value=${relevanceFilter}
							onChange=${(event) => setRelevanceFilter(event.target.value)}
						>
							<option value="all">ALL SIGNAL</option>
							<option value="high">HIGH ONLY</option>
						</select>
					</label>
				</div>
			</section>

			<section className="news-workspace-shell">
				<div className="news-summary-panel">
					<div className="news-panel-header">
						<div className="sector-section-label">Portfolio News Summary</div>
					</div>
					${
						portfolioNewsSummary?.hasNews
							? html`
								<div className="news-summary-body">
									${
										hasMacroItems
											? html`
												<div className="news-summary-section is-macros">
													<div className="news-summary-title">Macros</div>
													${renderSummaryChapters(portfolioNewsSummary.macros)}
												</div>
											`
											: null
									}

									<div className="news-summary-section is-top-tickers">
										<div className="news-summary-title">Top tickers</div>
										<div className="news-ticker-briefs">
											${portfolioNewsSummary.topTickers.map(
												(summaryItem) => html`
													<article
														key=${summaryItem.ticker}
														className="news-ticker-brief"
													>
														<div className="news-ticker-brief-header">
															${renderTickerBriefLabel(summaryItem.ticker)}
															<div className="news-ticker-brief-weight">
																${
																	summaryItem.weightLabel ||
																	formatWeight(summaryItem.weightPct)
																}
															</div>
														</div>
														${renderSummaryChapters(summaryItem.chapters)}
													</article>
												`,
											)}
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
											item.summary || "No summary available for this article.";
										const canToggleSummary = shouldShowSummaryToggle(summary);
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
														${renderTickerPills(item.sourceTickers)}
													</div>
													<div className="news-story-age">${formatRelativeTime(item)}</div>
												</div>

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
													<span className="news-story-source">${formatDomain(item)}</span>
													<span className=${`news-story-tag ${getRelevanceTone(item.relevancy)}`}>
														${String(item.relevancy || "low").toUpperCase()}
													</span>
													<span className="news-story-tag">
														${formatCategory(item.category)}
													</span>
													<span className=${`news-story-tag ${getSentimentTone(item.sentiment)}`}>
														${formatSentiment(item.sentiment)}
													</span>
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
