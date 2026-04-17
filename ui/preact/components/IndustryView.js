import { html } from "htm/preact";

import { fmt } from "../format.js";
import {
	getIconDefinition,
	getSectorDisplayLabel,
	getSectorIconName,
} from "../industryIcons.js";

function toneClass(value) {
	const numeric = Number(value);
	if (Number.isNaN(numeric) || numeric === 0) return "neutral";
	return numeric > 0 ? "positive" : "negative";
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
}) {
	const industryCharCount = maxTextLength(
		filteredIndustries.map((industry) => industry.industry),
		"Industry".length,
	);
	const stockCountCharCount = maxTextLength(
		filteredIndustries.map((industry) => industry.stock_count ?? "--"),
		2,
	);

	return html`
		<div class="industry-view">
			<section class="industry-hero">
				<div class="industry-hero-top">
					<div class="industry-hero-copy">
						<div class="industry-section-label">Market-wide scan</div>
						<h2 class="industry-hero-title">Industry Pulse</h2>
					</div>
					<div class="industry-controls">
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
									<span class="industry-sector-name">
										${renderIcon(
											getSectorIconName(option.sector),
											"industry-sector-glyph",
										)}
										<span class="industry-sector-label">
											${getSectorDisplayLabel(option.sector)}
										</span>
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
					</div>
				</div>
			</section>

			<section
				class=${`industry-ledger-shell ${
					!filteredIndustries.length && !isLoading ? "is-empty" : ""
				}`}
			>
				<div class="industry-ledger-header">
					<div class="industry-ledger-title-wrap">
						<div class="industry-section-label">Industry ledger</div>
						<div class="industry-ledger-title">
							${selectedSector === "ALL" ? "All" : selectedSector}
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
									class="industry-ledger-table"
									style=${{
										"--industry-name-char-count": industryCharCount + 1,
										"--industry-stocks-char-count": stockCountCharCount + 2,
									}}
								>
									<colgroup>
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
											<th>${renderSortableHeader("Industry", "industry", sortKey, sortDirection, setSortKey)}</th>
											<th>${renderSortableHeader("No.", "stock_count", sortKey, sortDirection, setSortKey)}</th>
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
												<td class="industry-name-cell">
													<span class="industry-name-ident">
														<span
															class="industry-sector-icon"
															title=${industry.sector}
															aria-label=${industry.sector}
														>
															${renderIcon(
																getSectorIconName(industry.sector),
																"industry-row-glyph",
															)}
														</span>
														<span class="industry-name">${industry.industry}</span>
													</span>
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
