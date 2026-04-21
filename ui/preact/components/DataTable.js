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

const EVALUATION_METRIC_COLUMN_KEYS = [
	"rank",
	"overall_score",
	"quality_score",
	"valuation_score",
	"moat_score",
	"upside_score",
	"bull_probability",
	"bear_probability",
];

function getTickerDisplayValue(ticker) {
	return normalizeTicker(ticker).replace("-", ".");
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
		return rows.map((row) => getTickerDisplayValue(row.ticker));
	}

	const formatter = fmt[col.format] || fmt.default;
	return rows.map((row) => formatter(row[col.key]));
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

function getColumnWidthValue(rows, col, widthGroupCharCounts) {
	if (col.key === "ticker") {
		return "var(--ticker-column-width)";
	}
	if (col.key === "remove") {
		return "52px";
	}

	const charCount = col.widthGroup
		? widthGroupCharCounts[col.widthGroup]
		: getColumnCharCount(getColumnDisplayValues(rows, col), col.label || "");
	return getColumnWidthStyle(charCount, WIDTH_GROUP_OPTIONS[col.widthGroup])
		?.width;
}

function getEvaluationTableStyle(rows, cols, widthGroupCharCounts) {
	const evaluationMetricColumns = cols.filter((col) =>
		EVALUATION_METRIC_COLUMN_KEYS.includes(col.key),
	);
	if (evaluationMetricColumns.length === 0) {
		return {};
	}

	const minimumWidthTerms = cols
		.map((col) => getColumnWidthValue(rows, col, widthGroupCharCounts))
		.filter(Boolean);

	return {
		"--table-flex-column-count": String(evaluationMetricColumns.length),
		"--table-min-width": `calc(${minimumWidthTerms.join(" + ")})`,
		"--table-evaluation-flex-column-width":
			"calc((100% - var(--table-min-width)) / var(--table-flex-column-count))",
	};
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
	const formatter = fmt[format] || fmt.default;

	let content;
	if (format === "percent") {
		const numeric = Number(valueForDisplay);
		const badgeClass = numeric > 0 ? "positive" : numeric < 0 ? "negative" : "";
		content = html`<span class=${`badge ${badgeClass}`}
      >${formatter(valueForDisplay)}</span
    >`;
	} else if (format === "percent_neutral") {
		content = html`<span class="cell-weight"
      >${formatter(valueForDisplay)}</span
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
      >${formatter(valueForDisplay)}</span
    >`;
	} else {
		content = formatter(valueForDisplay);
	}

	// Apply conditional coloring
	const colorKey = col.key;
	const isColorizable =
		["score", "prob", "percent_neutral", "number", "market_cap"].includes(
			format,
		) || ["rank", "rsi", "market_cap"].includes(colorKey);

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

		if (tab === "all") return isHolding || isEval;
		if (tab === "holdings") return isHolding;
		return isEval;
	});

	const sorted = sortRows(filtered, sortCol, sortDir);
	const widthGroupCharCounts = getWidthGroupCharCounts(sorted, cols);
	const colorMeta = calculateScoreColorMetadata(sorted, cols, {
		colorBandFraction: CONFIG.colorBandFraction,
		keyStandards: colorStandards,
	});
	const tableWrapperStyle = {
		"--ticker-char-count": tickerCharCount,
		...(tab === "evaluations"
			? getEvaluationTableStyle(sorted, cols, widthGroupCharCounts)
			: {}),
	};
	const tableWrapperClassName = [
		"table-wrapper data-table-scroll",
		tab === "evaluations" ? "table-wrapper-evaluations" : "",
	]
		.filter(Boolean)
		.join(" ");
	const tableClassName = [
		"data-table",
		tab === "evaluations" ? "data-table-evaluations" : "",
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
								style=${
									tab === "evaluations"
										? null
										: getColumnWidthStyle(
												widthGroupCharCounts[col.widthGroup],
												WIDTH_GROUP_OPTIONS[col.widthGroup],
											)
								}
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
							sorted.length
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
					</tbody>
				</table>
			</div>
		</div>
	`;
}
