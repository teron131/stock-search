import { html } from "htm/preact";

import { fmt } from "../format.js";
import { getIconDefinition, getSectorIconName } from "../industryIcons.js";

function toneClass(value) {
	const numeric = Number(value);
	if (Number.isNaN(numeric) || numeric === 0) return "neutral";
	return numeric > 0 ? "positive" : "negative";
}

function formatTimestamp(value) {
	if (!value) return "Awaiting snapshot";
	const timestamp = new Date(value);
	return timestamp.toLocaleString("en-US", {
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function maxTextLength(values, fallbackLength) {
	return values.reduce(
		(maxLength, value) => Math.max(maxLength, String(value || "").length),
		fallbackLength,
	);
}

function renderIcon(iconName, className) {
	const iconDefinition = getIconDefinition(iconName);
	return html`
		<svg
			aria-hidden="true"
			focusable="false"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-width="1.3"
			stroke-linecap="round"
			stroke-linejoin="round"
			class=${className}
		>
			${iconDefinition.paths.map((pathValue) => html`<path d=${pathValue} />`)}
		</svg>
	`;
}

function renderSortableHeader(label, key, sortKey, sortDirection, setSortKey) {
	const isActive = sortKey === key;
	return html`
		<button
			type="button"
			class=${`industry-header-btn ${isActive ? "active" : ""}`}
			onClick=${() => setSortKey(key)}
		>
			${label}${isActive ? ` ${sortDirection === "desc" ? "↓" : "↑"}` : ""}
		</button>
	`;
}

export function IndustryView({
	meta,
	isLoading,
	lastError,
	sectorOptions,
	selectedSector,
	setSelectedSector,
	sortKey,
	sortDirection,
	setSortKey,
	filteredIndustries,
	breadth,
}) {
	const breadthCopy = filteredIndustries.length
		? `${breadth.advancingCount} up / ${breadth.decliningCount} down / ${breadth.unchangedCount} flat`
		: "No industries loaded";
	const showSectorColumn = selectedSector === "ALL";
	const sectorCharCount = maxTextLength(
		filteredIndustries.map((industry) => industry.sector),
		"Sector".length,
	);
	const industryCharCount = maxTextLength(
		filteredIndustries.map((industry) => industry.industry),
		"Industry".length,
	);

	return html`
		<div class="industry-view">
			<section class="industry-hero">
				<div class="industry-hero-copy">
					<div class="industry-section-label">Market-wide scan</div>
					<h2 class="industry-hero-title">Industry Pulse</h2>
					<p class="industry-hero-text">
						Track sector rotation, market-cap concentration, and operating
						quality shifts across the StockAnalysis industry universe.
					</p>
					<div class="industry-breadth-row">
						<span class="industry-breadth-label">Breadth</span>
						<span class=${`industry-breadth-value ${toneClass(
							breadth.averageChangePercent1d,
						)}`}>
							${breadthCopy}
						</span>
					</div>
				</div>
				<div class="industry-hero-metrics">
					<div class="industry-metric-card">
						<div class="industry-section-label">Updated</div>
						<div class="industry-metric-value">
							${formatTimestamp(meta.fetched_at)}
						</div>
					</div>
					<div class="industry-metric-card">
						<div class="industry-section-label">Sectors</div>
						<div class="industry-metric-value">${meta.sector_count || 0}</div>
					</div>
					<div class="industry-metric-card">
						<div class="industry-section-label">Industries</div>
						<div class="industry-metric-value">${meta.industry_count || 0}</div>
					</div>
					<div class="industry-metric-card">
						<div class="industry-section-label">Average 1D</div>
						<div class=${`industry-metric-value industry-tone ${toneClass(
							breadth.averageChangePercent1d,
						)}`}>
							${fmt.percent_neutral(breadth.averageChangePercent1d)}
						</div>
					</div>
				</div>
			</section>

			<section class="industry-controls">
				<div class="industry-sector-rail">
					${sectorOptions.map(
						(option) => html`
						<button
							type="button"
							class=${`industry-sector-chip ${
								selectedSector === option.sector ? "active" : ""
							}`}
							onClick=${() => setSelectedSector(option.sector)}
						>
							<span class="industry-sector-top">
								<span class="industry-sector-name">
									${renderIcon(
										getSectorIconName(option.sector),
										"industry-sector-glyph",
									)}
									<span class="industry-sector-label">${option.sector}</span>
								</span>
								<span class="industry-sector-meta">${option.count}</span>
							</span>
							<span class=${`industry-sector-move industry-tone ${toneClass(
								option.avg_change_percent_1d,
							)}`}>
								${fmt.percent_neutral(option.avg_change_percent_1d)}
							</span>
						</button>
					`,
					)}
				</div>
			</section>

			<section class="industry-ledger-shell">
				<div class="industry-ledger-header">
					<div class="industry-ledger-title-wrap">
						<div class="industry-section-label">Industry ledger</div>
						<div class="industry-ledger-title">
							${selectedSector === "ALL" ? "Full market tape" : selectedSector}
						</div>
					</div>
					<div class="industry-ledger-status">
						${
							isLoading
								? "Refreshing snapshot..."
								: `${filteredIndustries.length} industries in scope`
						}
					</div>
				</div>

				${
					!filteredIndustries.length && !isLoading
						? html`
							<div class="industry-empty-state">
								<div class="industry-empty-title">
									${lastError ? "Industry snapshot unavailable" : "No industries to display"}
								</div>
								<div class="industry-empty-copy">
									${
										lastError
											? "The latest market-wide snapshot could not be loaded. Try syncing again."
											: "Adjust the sector filter or refresh the snapshot."
									}
								</div>
							</div>
						`
						: html`
							<div class="industry-ledger-table-wrap">
								<table
									class=${`industry-ledger-table ${
										showSectorColumn ? "show-sector-column" : ""
									}`}
									style=${{
										"--industry-sector-char-count": sectorCharCount + 3,
										"--industry-name-char-count": industryCharCount + 4,
									}}
								>
									<colgroup>
										${
											showSectorColumn
												? html`<col class="industry-col-sector" />`
												: null
										}
										<col class="industry-col-name" />
										<col class="industry-col-stocks" />
										<col class="industry-col-cap" />
										<col class="industry-col-pe" />
										<col class="industry-col-profit" />
										<col class="industry-col-gross" />
										<col class="industry-col-1d" />
										<col class="industry-col-1m" />
										<col class="industry-col-1y" />
									</colgroup>
									<thead>
										<tr>
											${showSectorColumn ? html`<th>${renderSortableHeader("Sector", "sector", sortKey, sortDirection, setSortKey)}</th>` : null}
											<th>${renderSortableHeader("Industry", "industry", sortKey, sortDirection, setSortKey)}</th>
											<th>${renderSortableHeader("Stocks", "stock_count", sortKey, sortDirection, setSortKey)}</th>
											<th>${renderSortableHeader("Mkt Cap", "market_cap", sortKey, sortDirection, setSortKey)}</th>
											<th>${renderSortableHeader("PE", "pe", sortKey, sortDirection, setSortKey)}</th>
											<th>${renderSortableHeader("PROFIT", "profit_margin", sortKey, sortDirection, setSortKey)}</th>
											<th>${renderSortableHeader("GROSS", "gross_margin", sortKey, sortDirection, setSortKey)}</th>
											<th>${renderSortableHeader("1D", "change_percent_1d", sortKey, sortDirection, setSortKey)}</th>
											<th>${renderSortableHeader("1M", "change_percent_1m", sortKey, sortDirection, setSortKey)}</th>
											<th>${renderSortableHeader("1Y", "change_percent_1y", sortKey, sortDirection, setSortKey)}</th>
										</tr>
									</thead>
									<tbody>
										${filteredIndustries.map(
											(industry) => html`
											<tr>
												${
													showSectorColumn
														? html`
															<td class="industry-sector-cell">
																<span class="industry-sector-ident">
																	${renderIcon(
																		getSectorIconName(industry.sector),
																		"industry-row-glyph",
																	)}
																	<span class="industry-sector-text">
																		${industry.sector}
																	</span>
																</span>
															</td>
														`
														: null
												}
												<td class="industry-name-cell">
													<span class="industry-name">${industry.industry}</span>
												</td>
												<td>${industry.stock_count ?? "--"}</td>
												<td>${fmt.market_cap(industry.market_cap)}</td>
												<td>${fmt.number(industry.pe)}</td>
												<td class=${`industry-tone ${toneClass(industry.profit_margin)}`}>
													${fmt.percent_neutral(industry.profit_margin)}
												</td>
												<td class=${`industry-tone ${toneClass(industry.gross_margin)}`}>
													${fmt.percent_neutral(industry.gross_margin)}
												</td>
												<td class=${`industry-tone ${toneClass(industry.change_percent_1d)}`}>
													${fmt.percent(industry.change_percent_1d)}
												</td>
												<td class=${`industry-tone ${toneClass(industry.change_percent_1m)}`}>
													${fmt.percent(industry.change_percent_1m)}
												</td>
												<td class=${`industry-tone ${toneClass(industry.change_percent_1y)}`}>
													${fmt.percent(industry.change_percent_1y)}
												</td>
											</tr>
										`,
										)}
									</tbody>
								</table>
							</div>
						`
				}
			</section>
		</div>
	`;
}
