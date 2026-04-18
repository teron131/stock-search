import { html } from "htm/preact";

import { calculateScoreColorMetadata, getScoreColor } from "../color.js";
import { CONFIG } from "../config.js";
import { fmt, parseMarketCap } from "../format.js";
import {
	getIconDefinition,
	getSectorDisplayLabel,
	getSectorIconName,
} from "../industryIcons.js";

const INDUSTRY_ALIAS_MIN_LENGTH = 24;

const INDUSTRY_ABBREVIATIONS = [
	[/\bManufacturing\b/g, "Mfg."],
	[/\bManufacturers\b/g, "Mfrs"],
	[/\bIndependent\b/g, "Indep."],
	[/\bPower\b/g, "Pwr."],
	[/\bProducers\b/g, "Prod."],
	[/\bSemiconductor\b/g, "Semi."],
	[/\bDistribution\b/g, "Dist."],
	[/\bEquipment\b/g, "Equip."],
	[/\bConstruction\b/g, "Constr."],
	[/\bMachinery\b/g, "Mach."],
	[/\bDealerships\b/g, "Dealers"],
	[/\bRecreational\b/g, "Rec."],
	[/\bVehicles\b/g, "Veh."],
	[/\bDistilleries\b/g, "Distill."],
	[/\bAppliances\b/g, "Appl."],
	[/\bExploration\b/g, "Expl."],
	[/\bProduction\b/g, "Prod."],
	[/\bTechnical\b/g, "Tech."],
	[/\bInstruments\b/g, "Instr."],
	[/\bIndustrial\b/g, "Ind."],
	[/\bFinancial\b/g, "Fin."],
	[/\bExchanges\b/g, "Exchs."],
	[/\bInformation\b/g, "Info"],
	[/\bTechnology\b/g, "Tech."],
	[/\bCommunications\b/g, "Comms."],
	[/\bProperty\b/g, "Prop."],
	[/\bCasualty\b/g, "Cas."],
	[/\bServices\b/g, "Svcs."],
	[/\bMarketing\b/g, "Mktg."],
	[/\bElectric\b/g, "Elec."],
	[/\bIntegrated\b/g, "Integ."],
	[/\bPrecious\b/g, "Prec."],
	[/\bSpecialty\b/g, "Spec."],
	[/\bFinancial\b/g, "Fin."],
	[/\bScientific\b/g, "Sci."],
	[/\bMedical\b/g, "Med."],
	[/\bResidential\b/g, "Res."],
	[/\bControls\b/g, "Ctrls."],
];

const INDUSTRY_COLOR_COLUMNS = [
	{ key: "market_cap", format: "market_cap" },
	{ key: "pe", format: "number" },
	{ key: "profit_margin", format: "percent_neutral" },
	{ key: "gross_margin", format: "percent_neutral" },
];

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

function getIndustryDisplayName(industryName) {
	const fullName = String(industryName || "").trim();
	if (!fullName) return "";

	if (fullName.length < INDUSTRY_ALIAS_MIN_LENGTH) {
		return fullName;
	}

	const compactName = INDUSTRY_ABBREVIATIONS.reduce(
		(currentName, [pattern, replacement]) =>
			currentName.replace(pattern, replacement),
		fullName,
	);

	return compactName.length < fullName.length ? compactName : fullName;
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

function renderIndustryMetric(value, color) {
	if (!color) return value;
	return html`<span style=${{ color }}>${value}</span>`;
}

export function IndustryView({
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
		filteredIndustries.map((industry) =>
			getIndustryDisplayName(industry.industry),
		),
		"Industry".length,
	);
	const industryColorMeta = calculateScoreColorMetadata(
		filteredIndustries,
		INDUSTRY_COLOR_COLUMNS,
		{
			colorBandFraction: CONFIG.colorBandFraction,
		},
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
										"--industry-name-char-count": industryCharCount,
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
										${filteredIndustries.map((industry) => {
											const displayIndustryName = getIndustryDisplayName(
												industry.industry,
											);
											const marketCapColor = getScoreColor(
												parseMarketCap(industry.market_cap),
												industryColorMeta.market_cap,
											);
											const peColor = getScoreColor(
												industry.pe,
												industryColorMeta.pe,
											);
											const profitMarginColor = getScoreColor(
												industry.profit_margin,
												industryColorMeta.profit_margin,
											);
											const grossMarginColor = getScoreColor(
												industry.gross_margin,
												industryColorMeta.gross_margin,
											);
											return html`
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
														<span class="industry-name" title=${industry.industry}>
															${displayIndustryName}
														</span>
													</span>
												</td>
												<td>${industry.stock_count ?? "--"}</td>
												<td>${renderIndustryMetric(
													fmt.market_cap(industry.market_cap),
													marketCapColor,
												)}</td>
												<td>${renderIndustryMetric(
													fmt.number(industry.pe),
													peColor,
												)}</td>
												<td class=${`industry-tone ${toneClass(industry.profit_margin)}`}>
													${renderIndustryMetric(
														fmt.percent_neutral(industry.profit_margin),
														profitMarginColor,
													)}
												</td>
												<td class=${`industry-tone ${toneClass(industry.gross_margin)}`}>
													${renderIndustryMetric(
														fmt.percent_neutral(industry.gross_margin),
														grossMarginColor,
													)}
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
										`;
										})}
									</tbody>
								</table>
							</div>
						`
				}
			</section>
		</div>
	`;
}
