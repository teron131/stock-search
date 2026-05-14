import { html } from "htm/react";

import { calculateScoreColorMetadata } from "../color.js";
import { CONFIG } from "../config.js";
import { fmt, parseMarketCap } from "../format.js";
import {
	getColumnCharCount,
	getToneClass,
	renderConditionallyColoredValue,
} from "../tableStyle.js";
import {
	getTradingViewTickerTagSymbol,
	normalizeTickerLabel,
} from "../tradingViewSymbols.js";
import { getIconDefinition, getSectorIconName } from "./icons.js";

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
			strokeWidth="1.3"
			strokeLinecap="round"
			strokeLinejoin="round"
			className=${className}
		>
			${iconDefinition.paths.map(
				(pathValue) => html`<path key=${pathValue} d=${pathValue} />`,
			)}
		</svg>
	`;
}

function renderSortableHeader(label, key, sortKey, sortDirection, setSortKey) {
	const isActive = sortKey === key;
	return html`
		<button
			type="button"
			className=${`sector-header-btn ${isActive ? "active" : ""}`}
			onClick=${() => setSortKey(key)}
		>
			${label}${isActive ? ` ${sortDirection === "desc" ? "↓" : "↑"}` : ""}
		</button>
	`;
}

function renderTopTickerTags(tickers) {
	const tickerTags = Array.isArray(tickers)
		? tickers
				.map((ticker) => {
					const label = normalizeTickerLabel(ticker);
					return {
						label,
						symbol: getTradingViewTickerTagSymbol(label, {
							allowFunds: true,
						}),
					};
				})
				.filter((ticker) => ticker.label)
				.slice(0, TOP_TICKER_TAG_LIMIT)
		: [];
	if (!tickerTags.length) {
		return null;
	}

	return html`
		<span className="sector-top-tickers" aria-label="Top market-cap tickers">
			${tickerTags.map((ticker) =>
				ticker.symbol
					? html`
							<tv-ticker-tag
								key=${ticker.label}
								className="sector-top-ticker-tag"
								symbol=${ticker.symbol}
								preserve-text
								hide-background
								theme="dark"
								transparent
							>${ticker.label}</tv-ticker-tag>
						`
					: html`
							<span
								key=${ticker.label}
								className="sector-top-ticker-tag sector-top-ticker-fallback"
							>
								${ticker.label}
							</span>
						`,
			)}
		</span>
	`;
}

function renderSectorHeader(column, sortKey, sortDirection, setSortKey) {
	const key = column.sortKey || column.className;
	if (!column.sortKey) {
		return html`<th key=${key} className=${column.headerClassName}>
			${column.label}
		</th>`;
	}
	return html`
		<th key=${key}>
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
		<div className="sector-view">
			<section className="sector-hero">
				<div className="sector-hero-top">
					<div className="sector-hero-copy">
						<div className="sector-section-label">Market-wide scan</div>
						<h2 className="sector-hero-title">Sector Pulse</h2>
					</div>
				</div>
			</section>

			<section
				className=${`sector-ledger-shell ${
					!filteredSectors.length && !isLoading ? "is-empty" : ""
				}`}
			>
				<div className="sector-ledger-header">
					<div className="sector-ledger-title-wrap">
						<div className="sector-section-label">Sector ledger</div>
						<div className="sector-ledger-title">All sectors</div>
					</div>
					<div className="sector-ledger-status">
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
							<div className="sector-empty-state">
								<div className="sector-empty-title">
									${lastError ? "Sector snapshot unavailable" : "No sectors to display"}
								</div>
								<div className="sector-empty-copy">
									${
										lastError
											? "The latest market-wide snapshot could not be loaded. Try syncing again."
											: "Refresh the snapshot to load sector data."
									}
								</div>
							</div>
						`
						: html`
								<div className="sector-ledger-table-wrap data-table-scroll">
									<table
										className="sector-ledger-table data-table"
										style=${{
											"--sector-name-char-count": sectorCharCount,
										}}
									>
										<colgroup>
											${SECTOR_TABLE_COLUMNS.map(
												(column) =>
													html`<col
														key=${column.sortKey || column.className}
														className=${column.className}
													/>`,
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
													<tr key=${sector.sector}>
														<td className="sector-name-cell">
															<span className="sector-name-ident">
																<span
																	className="sector-icon"
																	title=${sector.sector}
																	aria-label=${sector.sector}
																>
																	${renderIcon(
																		getSectorIconName(sector.sector),
																		"sector-row-glyph",
																	)}
																</span>
																<span className="sector-name" title=${sector.sector}>
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
														<td className=${getToneClass(
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
														<td className=${getToneClass(
															sector.change_percent_1d,
															"sector-tone",
														)}>
															${fmt.percent(sector.change_percent_1d)}
														</td>
														<td className=${getToneClass(
															sector.change_percent_1y,
															"sector-tone",
														)}>
															${fmt.percent(sector.change_percent_1y)}
														</td>
														<td className="sector-top-tickers-cell">
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
