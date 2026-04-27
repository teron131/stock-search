import { html } from "htm/preact";

import { calculateScoreColorMetadata } from "../color.js";
import { CONFIG } from "../config.js";
import { fmt, parseMarketCap } from "../format.js";
import { getIconDefinition, getSectorIconName } from "../sectorIcons.js";
import {
	getColumnCharCount,
	getToneClass,
	renderConditionallyColoredValue,
} from "../tableStyle.js";

const SECTOR_ALIAS_MIN_LENGTH = 24;

const SECTOR_ABBREVIATIONS = [
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

const SECTOR_COLOR_COLUMNS = [
	{ key: "market_cap", format: "market_cap" },
	{ key: "pe", format: "number" },
	{ key: "profit_margin", format: "percent_neutral" },
];
const TOP_TICKER_TAG_LIMIT = 5;

const SECTOR_TABLE_COLUMNS = [
	{ className: "sector-col-name", label: "Sector", sortKey: "sector" },
	{ className: "sector-col-stocks", label: "Stocks", sortKey: "stock_count" },
	{ className: "sector-col-cap", label: "Mkt Cap", sortKey: "market_cap" },
	{ className: "sector-col-pe", label: "PE", sortKey: "pe" },
	{
		className: "sector-col-profit",
		label: "PROFIT",
		sortKey: "profit_margin",
	},
	{ className: "sector-col-1d", label: "1D", sortKey: "change_percent_1d" },
	{ className: "sector-col-1y", label: "1Y", sortKey: "change_percent_1y" },
	{
		className: "sector-col-top-tickers",
		headerClassName: "sector-top-tickers-heading",
		label: "Top stocks",
	},
];

function getSectorDisplayName(sectorName) {
	const fullName = String(sectorName || "").trim();
	if (!fullName) return "";

	if (fullName.length < SECTOR_ALIAS_MIN_LENGTH) {
		return fullName;
	}

	const compactName = SECTOR_ABBREVIATIONS.reduce(
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
			class=${`sector-header-btn ${isActive ? "active" : ""}`}
			onClick=${() => setSortKey(key)}
		>
			${label}${isActive ? ` ${sortDirection === "desc" ? "↓" : "↑"}` : ""}
		</button>
	`;
}

function getTradingViewTickerTagSymbol(ticker) {
	return String(ticker || "")
		.trim()
		.toUpperCase()
		.replace("-", ".");
}

function renderTopTickerTags(tickers) {
	const normalizedTickers = Array.isArray(tickers)
		? tickers
				.map(getTradingViewTickerTagSymbol)
				.filter(Boolean)
				.slice(0, TOP_TICKER_TAG_LIMIT)
		: [];
	if (!normalizedTickers.length) {
		return null;
	}

	return html`
		<span class="sector-top-tickers" aria-label="Top market-cap tickers">
			${normalizedTickers.map(
				(ticker) => html`
					<tv-ticker-tag
						class="sector-top-ticker-tag"
						symbol=${ticker}
						preserve-text
						hide-background
						theme="dark"
						transparent
					>${ticker}</tv-ticker-tag>
				`,
			)}
		</span>
	`;
}

function renderSectorHeader(column, sortKey, sortDirection, setSortKey) {
	if (!column.sortKey) {
		return html`<th class=${column.headerClassName}>${column.label}</th>`;
	}
	return html`
		<th>
			${renderSortableHeader(
				column.label,
				column.sortKey,
				sortKey,
				sortDirection,
				setSortKey,
			)}
		</th>
	`;
}

export function SectorView({
	isLoading,
	lastError,
	sortKey,
	sortDirection,
	setSortKey,
	filteredSectors,
}) {
	const sectorCharCount = getColumnCharCount(
		filteredSectors.map((sector) => getSectorDisplayName(sector.sector)),
		"Sector",
		{ paddingChars: 4 },
	);
	const sectorColorMeta = calculateScoreColorMetadata(
		filteredSectors,
		SECTOR_COLOR_COLUMNS,
		{
			colorBandFraction: CONFIG.colorBandFraction,
		},
	);

	return html`
		<div class="sector-view">
			<section class="sector-hero">
				<div class="sector-hero-top">
					<div class="sector-hero-copy">
						<div class="sector-section-label">Market-wide scan</div>
						<h2 class="sector-hero-title">Sector Pulse</h2>
					</div>
				</div>
			</section>

			<section
				class=${`sector-ledger-shell ${
					!filteredSectors.length && !isLoading ? "is-empty" : ""
				}`}
			>
				<div class="sector-ledger-header">
					<div class="sector-ledger-title-wrap">
						<div class="sector-section-label">Sector ledger</div>
						<div class="sector-ledger-title">All sectors</div>
					</div>
					<div class="sector-ledger-status">
						${
							isLoading
								? "Refreshing snapshot..."
								: `${filteredSectors.length} sectors in scope`
						}
					</div>
				</div>

				${
					!filteredSectors.length && !isLoading
						? html`
							<div class="sector-empty-state">
								<div class="sector-empty-title">
									${lastError ? "Sector snapshot unavailable" : "No sectors to display"}
								</div>
								<div class="sector-empty-copy">
									${
										lastError
											? "The latest market-wide snapshot could not be loaded. Try syncing again."
											: "Refresh the snapshot to load sector data."
									}
								</div>
							</div>
						`
						: html`
								<div class="sector-ledger-table-wrap data-table-scroll">
									<table
										class="sector-ledger-table data-table"
										style=${{
											"--sector-name-char-count": sectorCharCount,
										}}
									>
										<colgroup>
											${SECTOR_TABLE_COLUMNS.map(
												(column) => html`<col class=${column.className} />`,
											)}
										</colgroup>
										<thead>
											<tr>
												${SECTOR_TABLE_COLUMNS.map((column) =>
													renderSectorHeader(
														column,
														sortKey,
														sortDirection,
														setSortKey,
													),
												)}
											</tr>
										</thead>
										<tbody>
											${filteredSectors.map((sector) => {
												const displaySectorName = getSectorDisplayName(
													sector.sector,
												);
												const marketCapValue = parseMarketCap(
													sector.market_cap,
												);
												return html`
													<tr>
														<td class="sector-name-cell">
															<span class="sector-name-ident">
																<span
																	class="sector-icon"
																	title=${sector.sector}
																	aria-label=${sector.sector}
																>
																	${renderIcon(
																		getSectorIconName(sector.sector),
																		"sector-row-glyph",
																	)}
																</span>
																<span class="sector-name" title=${sector.sector}>
																	${displaySectorName}
																</span>
															</span>
														</td>
														<td>${sector.stock_count ?? "--"}</td>
														<td>${renderConditionallyColoredValue(
															fmt.market_cap(sector.market_cap),
															{
																value: marketCapValue,
																colorMeta: sectorColorMeta,
																colorKey: "market_cap",
															},
														)}</td>
														<td>${renderConditionallyColoredValue(
															fmt.number(sector.pe),
															{
																value: sector.pe,
																colorMeta: sectorColorMeta,
																colorKey: "pe",
															},
														)}</td>
														<td class=${getToneClass(
															sector.profit_margin,
															"sector-tone",
														)}>
															${renderConditionallyColoredValue(
																fmt.percent_neutral(sector.profit_margin),
																{
																	value: sector.profit_margin,
																	colorMeta: sectorColorMeta,
																	colorKey: "profit_margin",
																},
															)}
														</td>
														<td class=${getToneClass(
															sector.change_percent_1d,
															"sector-tone",
														)}>
															${fmt.percent(sector.change_percent_1d)}
														</td>
														<td class=${getToneClass(
															sector.change_percent_1y,
															"sector-tone",
														)}>
															${fmt.percent(sector.change_percent_1y)}
														</td>
														<td class="sector-top-tickers-cell">
															${renderTopTickerTags(sector.top_tickers)}
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
