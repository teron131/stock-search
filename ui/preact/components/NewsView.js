import { html } from "htm/preact";
import { useState } from "preact/hooks";

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
		(ticker) => html`<span class="news-ticker-pill">${ticker}</span>`,
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
			? html`<strong key=${`${part}-${index}`} class="news-inline-ticker">${part}</strong>`
			: part,
	);
}

function renderSummaryChapters(chapters) {
	const safeChapters = Array.isArray(chapters) ? chapters.filter(Boolean) : [];
	if (safeChapters.length === 0) {
		return null;
	}

	return html`
		<div class="news-summary-list">
			${safeChapters.map(
				(chapter) => html`
					<div class="news-summary-item">
						<div class="news-summary-item-topic">${chapter.headline}</div>
						<div class="news-summary-item-text">
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

export function NewsView({
	items,
	portfolioSummary,
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
	const hasMacroItems = (portfolioSummary?.macros || []).length > 0;
	const coverageText =
		isLoading && !hasItems
			? "Refreshing portfolio wire..."
			: `${items.length} stories across ${heldTickers.length} held tickers`;

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
		<div class="news-view">
			<section class="news-toolbar">
				<div class="news-toolbar-copy">
					<div class="industry-section-label">Portfolio wire</div>
					<div class="news-toolbar-heading">
						<h2 class="news-toolbar-title">Held Positions</h2>
						<div class="news-toolbar-status">
							${coverageText}
							${
								isRefreshing
									? html`
										<span class="news-toolbar-note">Background refresh</span>
									`
									: null
							}
							${
								failedTickers.length > 0
									? html`
										<span class="news-toolbar-note">
											${failedTickers.length} ticker${failedTickers.length === 1 ? "" : "s"} unavailable
										</span>
									`
									: null
							}
						</div>
					</div>
				</div>

				<div class="news-controls">
					<label class="news-control">
						<span class="news-control-label">Tickers</span>
						<select
							class="news-control-select"
							value=${tickerFilter}
							onChange=${(event) => setTickerFilter(event.target.value)}
						>
							<option value="ALL">ALL HELD</option>
							${heldTickers.map(
								(ticker) => html`<option value=${ticker}>${ticker}</option>`,
							)}
						</select>
					</label>

					<label class="news-control">
						<span class="news-control-label">Relevance</span>
						<select
							class="news-control-select"
							value=${relevanceFilter}
							onChange=${(event) => setRelevanceFilter(event.target.value)}
						>
							<option value="all">ALL SIGNAL</option>
							<option value="high">HIGH ONLY</option>
						</select>
					</label>
				</div>
			</section>

			<section class="news-workspace-shell">
				<div class="news-summary-panel">
					<div class="news-panel-header">
						<div class="industry-section-label">Grand summary</div>
					</div>
					${
						portfolioSummary?.hasNews
							? html`
								<div class="news-summary-body">
									${
										hasMacroItems
											? html`
												<div class="news-summary-section is-macros">
													<div class="news-summary-title">Macros</div>
													${renderSummaryChapters(portfolioSummary.macros)}
												</div>
											`
											: null
									}

									<div class="news-summary-section is-top-tickers">
										<div class="news-summary-title">Top tickers</div>
										<div class="news-ticker-briefs">
											${portfolioSummary.topTickers.map(
												(summaryItem) => html`
													<article class="news-ticker-brief">
														<div class="news-ticker-brief-header">
															<div class="news-ticker-brief-ticker">
																${summaryItem.ticker}
															</div>
															<div class="news-ticker-brief-weight">
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
								<div class="news-summary-body news-summary-placeholder">
									<div class="news-summary-title">Macros</div>
									<div class="news-summary-copy">
										Add held positions and load the feed to generate the chaptered desk note.
									</div>
								</div>
							`
					}
				</div>

				<div class="news-list-panel">
					<div class="news-panel-header">
						<div class="industry-section-label">Merged feed</div>
						<div class="news-panel-title">Latest coverage</div>
					</div>

					${
						isWaitingOnPortfolio
							? html`
								<div class="news-empty-state">
									<div class="news-empty-title">Loading portfolio scope</div>
									<div class="news-empty-copy">
										Preparing the held-position set before the portfolio news wire comes online.
									</div>
								</div>
							`
							: null
					}

					${
						!isWaitingOnPortfolio && !hasHoldings && !isLoading
							? html`
								<div class="news-empty-state">
									<div class="news-empty-title">No held positions in scope</div>
									<div class="news-empty-copy">
										Add a portfolio position to populate the portfolio-wide news wire.
									</div>
								</div>
							`
							: null
					}

					${
						!isWaitingOnPortfolio && hasHoldings && !hasItems && !isLoading
							? html`
								<div class="news-empty-state">
									<div class="news-empty-title">
										${lastError ? "News feed unavailable" : "No stories in scope"}
									</div>
									<div class="news-empty-copy">
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
								<div class="news-list">
									${items.map((item) => {
										const articleKey = item.url;
										const summary =
											item.summary || "No summary available for this article.";
										const canToggleSummary = shouldShowSummaryToggle(summary);
										const isExpanded = expandedArticleKeys.has(articleKey);
										return html`
											<article
												class=${`news-story-row ${isExpanded ? "is-expanded" : ""}`}
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
												<div class="news-story-topline">
													<div class="news-story-tickers">
														${renderTickerPills(item.sourceTickers)}
													</div>
													<div class="news-story-age">${formatRelativeTime(item)}</div>
												</div>

												<div class="news-story-headline">${item.title}</div>
												<div
													class=${`news-story-summary ${isExpanded ? "is-expanded" : ""}`}
												>
													${renderHighlightedText(summary, item.sourceTickers)}
												</div>
												${
													canToggleSummary
														? html`
															<div class="news-story-summary-actions">
																<button
																	type="button"
																	class="news-story-toggle"
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
															<div class="news-story-expanded-actions">
																<a
																	class="btn btn-secondary news-open-btn"
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

												<div class="news-story-footer">
													<span class="news-story-source">${formatDomain(item)}</span>
													<span class=${`news-story-tag ${getRelevanceTone(item.relevancy)}`}>
														${String(item.relevancy || "low").toUpperCase()}
													</span>
													<span class="news-story-tag">
														${formatCategory(item.category)}
													</span>
													<span class=${`news-story-tag ${getSentimentTone(item.sentiment)}`}>
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
