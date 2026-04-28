import { html } from "htm/preact";

import { calculateScoreColorMetadata } from "../color.js";
import { COLS, CONFIG, WIDTH_GROUP_OPTIONS } from "../config.js";
import { fmt, normalizeTicker, parseMarketCap } from "../format.js";
import {
	getColumnCharCount,
	getColumnWidthStyle,
	renderConditionallyColoredValue,
} from "../tableStyle.js";
import { useQtyCellState } from "./useQtyCellState.js";

const NON_US_SUFFIXES = new Set(["HK", "JP", "KR", "KS", "KQ", "TT", "TW"]);
const US_EXCHANGE_PREFIXES = new Set(["AMEX", "NASDAQ", "NYSE"]);
const PLAIN_ALLOCATION_COLUMNS = new Set([
	"total",
	"notional_value",
	"weight_pct",
	"notional_weight_pct",
]);

function getTickerDisplayValue(ticker) {
	return normalizeTicker(ticker).replace("-", ".");
}

function isNonUsTicker(ticker) {
	const displayTicker = getTickerDisplayValue(ticker);
	if (/^\d/.test(displayTicker)) {
		return true;
	}

	const [prefix, prefixedSymbol] = displayTicker.includes(":")
		? displayTicker.split(":", 2)
		: ["", ""];
	if (prefixedSymbol) {
		return !US_EXCHANGE_PREFIXES.has(prefix);
	}

	const suffix = displayTicker.match(/\.([A-Z]{1,4})$/)?.[1];
	return suffix ? NON_US_SUFFIXES.has(suffix) : false;
}

function isNonUsLookthroughRow(row) {
	return Boolean(row?.etf_lookthrough_only) && isNonUsTicker(row?.ticker);
}

function getTickerCellLabel(row) {
	const ticker = getTickerDisplayValue(row?.ticker);
	const name = String(row?.name || "").trim();
	if (!isNonUsLookthroughRow(row) || !name || name === ticker) {
		return ticker;
	}
	return name
		.replace(/\bCorporation\b/gi, "Corp")
		.replace(/\bIncorporated\b/gi, "Inc.")
		.replace(/\s+(Co\.,?\s*)?Ltd\.?$/i, "")
		.replace(/\s+Inc\.?$/i, "")
		.replace(/\s+Corp\.?$/i, "")
		.trim();
}

function getColumnClassName(key) {
	return `table-col-${String(key || "").replaceAll("_", "-")}`;
}

function getColumnClusterClassName(cluster) {
	return cluster ? `table-cluster-${cluster}` : "";
}

function compareNullable(a, b, dir) {
	if (a == null) return 1;
	if (b == null) return -1;

	const na = typeof a === "string" ? a.toLowerCase() : a;
	const nb = typeof b === "string" ? b.toLowerCase() : b;

	if (na === nb) return 0;
	return dir === "asc" ? (na < nb ? -1 : 1) : na < nb ? 1 : -1;
}

function notionalTotal(value) {
	if (!value || typeof value !== "object") return null;
	const total =
		Number(value.from_stocks ?? 0) +
		Number(value.from_etf ?? 0) +
		Number(value.from_options ?? 0);
	return Number.isFinite(total) ? total : null;
}

function stripCurrencySymbol(value) {
	return String(value).replace(/^\$/, "");
}

function formatCellValue(row, col) {
	const formatter = fmt[col.format] || fmt.default;
	const formatted = formatter(row[col.key]);
	if (
		isNonUsTicker(row?.ticker) &&
		["currency", "market_cap"].includes(col.format)
	) {
		return stripCurrencySymbol(formatted);
	}
	return formatted;
}

function sortRows(rows, col, dir) {
	const sorted = [...rows];
	sorted.sort((a, b) => {
		if (col === "market_cap") {
			return compareNullable(
				parseMarketCap(a.market_cap),
				parseMarketCap(b.market_cap),
				dir,
			);
		}

		return compareNullable(a[col], b[col], dir);
	});
	return sorted;
}

function getColumnDisplayValues(rows, col) {
	if (col.key === "ticker") {
		return rows.map((row) => getTickerCellLabel(row));
	}

	return rows.map((row) => formatCellValue(row, col));
}

function getWidthGroupCharCounts(rows, cols) {
	const widthGroupCharCounts = {};

	for (const col of cols) {
		if (!col.widthGroup) {
			continue;
		}

		const charCount = getColumnCharCount(
			getColumnDisplayValues(rows, col),
			col.label || "",
			WIDTH_GROUP_OPTIONS[col.widthGroup],
		);

		widthGroupCharCounts[col.widthGroup] = Math.max(
			widthGroupCharCounts[col.widthGroup] || 0,
			charCount,
		);
	}

	return widthGroupCharCounts;
}

function QtyCell({ row, isUsingDemoData, onSetQuantity }) {
	const {
		canEdit,
		draftQty,
		onInput,
		onKeyDown,
		onBlur,
		stopHold,
		onSpinClick,
		onSpinKeyDown,
		onSpinPointerDown,
	} = useQtyCellState({
		row,
		isUsingDemoData,
		onSetQuantity,
	});

	return html`<div class="qty-control">
    <input
      class="qty-input"
      type="number"
      step="1"
      min="0"
      value=${draftQty}
      onInput=${onInput}
      onKeyDown=${onKeyDown}
      onBlur=${onBlur}
      disabled=${!canEdit}
    />
    <div class="qty-spin">
      <button
        type="button"
        class="qty-spin-btn"
        disabled=${!canEdit}
        onPointerDown=${onSpinPointerDown(1)}
        onPointerUp=${stopHold}
        onPointerCancel=${stopHold}
        onPointerLeave=${stopHold}
        onClick=${onSpinClick(1)}
        onKeyDown=${onSpinKeyDown(1)}
        title="Up"
      >
        ▲
      </button>
      <button
        type="button"
        class="qty-spin-btn"
        disabled=${!canEdit}
        onPointerDown=${onSpinPointerDown(-1)}
        onPointerUp=${stopHold}
        onPointerCancel=${stopHold}
        onPointerLeave=${stopHold}
        onClick=${onSpinClick(-1)}
        onKeyDown=${onSpinKeyDown(-1)}
        title="Down"
      >
        ▼
      </button>
    </div>
  </div>`;
}

function renderCell({
	row,
	col,
	colorMeta,
	onRemove,
	onSetQuantity,
	isUsingDemoData,
}) {
	const key = col.key;
	const format = col.format;

	if (key === "quantity" && onSetQuantity) {
		return html`<${QtyCell}
      row=${row}
      isUsingDemoData=${isUsingDemoData}
      onSetQuantity=${onSetQuantity}
    />`;
	}

	if (key === "remove") {
		return html`<button
      type="button"
      class="btn-remove-cell"
      onClick=${() => onRemove(row.ticker)}
      title="Remove"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>`;
	}

	if (key === "ticker") {
		const val = getTickerDisplayValue(row.ticker);
		if (isNonUsLookthroughRow(row)) {
			const label = getTickerCellLabel(row);
			return html`<span class="ticker-name-cell" title=${val}>
				<span class="ticker-name-primary">${label}</span>
			</span>`;
		}
		return html`<tv-ticker-tag
      symbol=${val}
      preserve-text
      hide-change
      hide-background
      theme="dark"
      transparent
      >${val}</tv-ticker-tag
    >`;
	}

	const valueForDisplay = row[key];

	let content;
	if (format === "percent") {
		const numeric = Number(valueForDisplay);
		const badgeClass = numeric > 0 ? "positive" : numeric < 0 ? "negative" : "";
		content = html`<span class=${`badge ${badgeClass}`}
      >${formatCellValue(row, col)}</span
    >`;
	} else if (
		format === "percent_neutral" &&
		key === "weight_pct" &&
		row.etf_lookthrough_only
	) {
		content = html`<span class="cell-weight">--</span>`;
	} else if (format === "percent_neutral") {
		content = html`<span class="cell-weight"
      >${formatCellValue(row, col)}</span
    >`;
	} else if (format === "score") {
		const numeric = Number(valueForDisplay);
		const scoreClass =
			numeric >= CONFIG.scoreThresholds.high
				? "score-high"
				: numeric <= CONFIG.scoreThresholds.low
					? "score-low"
					: "score-mid";
		content = html`<span class=${scoreClass}
      >${formatCellValue(row, col)}</span
    >`;
	} else {
		content = formatCellValue(row, col);
	}

	// Apply conditional coloring
	const colorKey = col.key;
	const isColorizable =
		!PLAIN_ALLOCATION_COLUMNS.has(colorKey) &&
		(["score", "prob", "percent_neutral", "number", "market_cap"].includes(
			format,
		) ||
			["rank", "rsi", "market_cap"].includes(colorKey));

	if (isColorizable && colorMeta?.[colorKey]) {
		const rawValue =
			colorKey === "market_cap"
				? parseMarketCap(row.market_cap)
				: row[colorKey];
		return renderConditionallyColoredValue(content, {
			value: rawValue,
			colorMeta,
			colorKey,
		});
	}

	return content;
}

export function DataTable({
	tab,
	rows,
	sortCol,
	sortDir,
	onSort,
	onRemove,
	onSetQuantity,
	colorStandards = null,
	isUsingDemoData = false,
	animateRows = true,
}) {
	const cols = COLS[tab];
	const isEvaluationTab = tab === "evaluations";
	const tickerCharCount = getColumnCharCount(
		rows.map((row) => getTickerDisplayValue(row.ticker)),
		"TICKER",
	);

	const filtered = rows.filter((r) => {
		const qty = Number(r.quantity);
		const hasQty = r.quantity != null && !Number.isNaN(qty);
		const isHolding = hasQty && qty > 0 && r.total != null;
		const hasEvalScore = r.overall_score != null && r.overall_score !== "";
		const hasEvalRank = r.rank != null;
		const isEval = hasEvalScore || hasEvalRank;
		const isLookthroughRepresentative =
			Boolean(r.etf_lookthrough_only) && (notionalTotal(r.notional) ?? 0) > 0;

		if (tab === "all")
			return isHolding || isEval || isLookthroughRepresentative;
		if (tab === "holdings") return isHolding;
		return isEval;
	});

	const sorted = sortRows(filtered, sortCol, sortDir);
	const hasRows = sorted.length > 0;
	const widthGroupCharCounts = getWidthGroupCharCounts(sorted, cols);
	const colorMeta = calculateScoreColorMetadata(sorted, cols, {
		colorBandFraction: CONFIG.colorBandFraction,
		keyStandards: colorStandards,
	});
	const evaluationFluidColumnCount = isEvaluationTab
		? cols.filter((col) => col.key !== "ticker" && col.key !== "remove").length
		: null;
	const tableWrapperStyle = {
		"--ticker-char-count": tickerCharCount,
		...(evaluationFluidColumnCount
			? { "--evaluation-fluid-column-count": evaluationFluidColumnCount }
			: {}),
	};
	const tableWrapperClassName = [
		"table-wrapper data-table-scroll",
		isEvaluationTab ? "table-wrapper-evaluations" : "",
	]
		.filter(Boolean)
		.join(" ");
	const tableClassName = [
		"data-table",
		isEvaluationTab ? "data-table-evaluations" : "",
	]
		.filter(Boolean)
		.join(" ");

	return html`
		<div class="table-shell">
			<div class="table-scroll-hint">Swipe sideways for full factor view</div>
			<div class=${tableWrapperClassName} style=${tableWrapperStyle}>
				<table id="main-table" class=${tableClassName}>
					<colgroup>
						${cols.map((col) => {
							const className = [
								getColumnClassName(col.key),
								getColumnClusterClassName(col.cluster),
							]
								.filter(Boolean)
								.join(" ");
							return html`<col
								class=${className}
								style=${getColumnWidthStyle(
									widthGroupCharCounts[col.widthGroup],
									WIDTH_GROUP_OPTIONS[col.widthGroup],
								)}
							/>`;
						})}
					</colgroup>
					<thead>
						<tr>
							${cols.map((c) => {
								const columnClassName = [
									getColumnClassName(c.key),
									getColumnClusterClassName(c.cluster),
								]
									.filter(Boolean)
									.join(" ");
								if (c.key === "remove")
									return html`<th class=${columnClassName}></th>`;
								const sortedClass =
									sortCol === c.key ? `sorted ${sortDir}` : "";
								return html`<th
									data-sort=${c.key}
									class=${`${columnClassName} ${sortedClass}`.trim()}
									onClick=${() => onSort(c.key)}
								>
									${c.label}
								</th>`;
							})}
						</tr>
					</thead>
					<tbody>
						${
							hasRows
								? sorted.map(
										(row, i) =>
											html`<tr
												key=${normalizeTicker(row.ticker)}
												class=${animateRows ? "animate-in" : ""}
												style=${
													animateRows
														? {
																animationDelay: `${i * CONFIG.animationDelayMs}ms`,
															}
														: null
												}
											>
												${cols.map(
													(col) =>
														html`<td
															class=${[
																getColumnClassName(col.key),
																getColumnClusterClassName(col.cluster),
															]
																.filter(Boolean)
																.join(" ")}
														>
														${renderCell({
															row,
															col,
															colorMeta,
															onRemove,
															onSetQuantity,
															isUsingDemoData,
														})}
													</td>`,
												)}
											</tr>`,
									)
								: null
						}
						${
							hasRows
								? null
								: html`
										<tr class="table-empty-row">
											<td colspan=${cols.length}>
												<div class="table-empty-state">
													<div class="table-empty-title">No rows in this view</div>
													<div class="table-empty-copy">
														Add positions or switch tabs to inspect available ticker data.
													</div>
												</div>
											</td>
										</tr>
									`
						}
					</tbody>
				</table>
			</div>
		</div>
	`;
}
