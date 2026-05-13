import { html } from "htm/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { calculateScoreColorMetadata } from "../color.js";
import { COLS, CONFIG, WIDTH_GROUP_OPTIONS } from "../config.js";
import { fmt, normalizeTicker, parseMarketCap } from "../format.js";
import {
	getColumnCharCount,
	getColumnWidthStyle,
	renderConditionallyColoredValue,
} from "../tableStyle.js";
import { getTradingViewTickerTagSymbol } from "../tradingViewSymbols.js";
import { useQtyCellState } from "./useQtyCellState.js";

const NON_US_SUFFIXES = new Set(["HK", "JP", "KR", "KS", "KQ", "TT", "TW"]);
const US_EXCHANGE_PREFIXES = new Set(["AMEX", "NASDAQ", "NYSE"]);
const PLAIN_ALLOCATION_COLUMNS = new Set([
	"total",
	"notional_value",
	"weight_pct",
	"notional_weight_pct",
]);
const VIRTUAL_ROW_HEIGHT_PX = 28;
const VIRTUAL_ROW_OVERSCAN = 6;
const VIRTUAL_INITIAL_VIEWPORT_ROWS = 18;
const VIRTUAL_INITIAL_VIEWPORT_HEIGHT =
	VIRTUAL_ROW_HEIGHT_PX * VIRTUAL_INITIAL_VIEWPORT_ROWS;

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

function isEtfLikeRow(row) {
	const equityType = String(row?.equity_type ?? "")
		.trim()
		.toUpperCase();
	const quoteType = String(row?.quote_type ?? "")
		.trim()
		.toUpperCase();
	return equityType === "ETF" || quoteType === "ETF";
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

function rowBelongsToTab(row, tab) {
	const qty = Number(row.quantity);
	const hasQty = row.quantity != null && !Number.isNaN(qty);
	const isHolding = hasQty && qty > 0 && row.total != null;
	const hasEvalScore = row.overall_score != null && row.overall_score !== "";
	const hasEvalRank = row.rank != null;
	const isEval = hasEvalScore || hasEvalRank;
	const isLookthroughRepresentative =
		Boolean(row.etf_lookthrough_only) && (notionalTotal(row.notional) ?? 0) > 0;

	if (tab === "all") return isHolding || isEval || isLookthroughRepresentative;
	if (tab === "holdings") return isHolding;
	return isEval;
}

function stripCurrencySymbol(value) {
	return String(value).replace(/^\$/, "");
}

function isProxiedStatCell(row, key) {
	return (
		Array.isArray(row?.proxied_stat_fields) &&
		row.proxied_stat_fields.includes(key)
	);
}

function formatCellValue(row, col) {
	if (
		col.key === "market_cap" &&
		isEtfLikeRow(row) &&
		!isProxiedStatCell(row, col.key)
	) {
		return "--";
	}
	const formatter = fmt[col.format] || fmt.default;
	const formatted = formatter(row[col.key]);
	if (isNonUsTicker(row?.ticker) && col.format === "currency") {
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

function getAriaSort(sortCol, sortDir, key) {
	if (sortCol !== key) return "none";
	return sortDir === "asc" ? "ascending" : "descending";
}

function getScrollState(scrollEl) {
	if (!scrollEl) {
		return {
			hasOverflowX: false,
			isScrolledX: false,
			hasMoreX: false,
		};
	}

	const maxScrollLeft = Math.max(
		0,
		scrollEl.scrollWidth - scrollEl.clientWidth,
	);
	const scrollLeft = Math.max(0, scrollEl.scrollLeft);
	return {
		hasOverflowX: maxScrollLeft > 1,
		isScrolledX: scrollLeft > 1,
		hasMoreX: maxScrollLeft - scrollLeft > 1,
	};
}

function statesEqual(a, b) {
	return (
		a.hasOverflowX === b.hasOverflowX &&
		a.isScrolledX === b.isScrolledX &&
		a.hasMoreX === b.hasMoreX
	);
}

function syncScrollState(setScrollState, scrollEl) {
	const nextState = getScrollState(scrollEl);
	setScrollState((currentState) =>
		statesEqual(currentState, nextState) ? currentState : nextState,
	);
}

function getVirtualWindow({ rowCount, start, viewportHeight }) {
	if (rowCount === 0) {
		return {
			start: 0,
			end: 0,
			topPadding: 0,
			bottomPadding: 0,
		};
	}

	const visibleCount = Math.ceil(viewportHeight / VIRTUAL_ROW_HEIGHT_PX);
	const safeStart = Math.min(Math.max(start, 0), Math.max(rowCount - 1, 0));
	const end = Math.min(
		rowCount,
		safeStart + visibleCount + VIRTUAL_ROW_OVERSCAN * 2,
	);

	return {
		start: safeStart,
		end,
		topPadding: safeStart * VIRTUAL_ROW_HEIGHT_PX,
		bottomPadding: (rowCount - end) * VIRTUAL_ROW_HEIGHT_PX,
	};
}

function getNextVirtualStart({ currentStart, scrollTop, viewportHeight }) {
	const visibleCount = Math.ceil(viewportHeight / VIRTUAL_ROW_HEIGHT_PX);
	const firstVisible = Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT_PX);
	const currentEnd = currentStart + visibleCount + VIRTUAL_ROW_OVERSCAN * 2;
	const overscanEdge = Math.max(2, Math.floor(VIRTUAL_ROW_OVERSCAN / 2));
	const shouldMoveWindow =
		firstVisible < currentStart + overscanEdge ||
		firstVisible + visibleCount > currentEnd - overscanEdge;

	if (!shouldMoveWindow) return currentStart;
	return Math.max(0, firstVisible - VIRTUAL_ROW_OVERSCAN);
}

function getColumnDisplayValues(rows, col) {
	if (col.key === "ticker") {
		return rows.map((row) => getTickerCellLabel(row));
	}

	return rows.map((row) => formatCellValue(row, col));
}

function getColumnCharCounts(rows, cols) {
	const columnCharCounts = {};

	for (const col of cols) {
		if (!col.widthGroup) {
			continue;
		}

		const charCount = getColumnCharCount(
			getColumnDisplayValues(rows, col),
			col.label || "",
			WIDTH_GROUP_OPTIONS[col.widthGroup],
		);

		columnCharCounts[col.key] = charCount;
	}

	return columnCharCounts;
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

	return html`<div className="qty-control">
    <input
      className="qty-input"
      type="number"
      step="1"
      min="0"
      value=${draftQty}
      onInput=${onInput}
      onKeyDown=${onKeyDown}
      onBlur=${onBlur}
      disabled=${!canEdit}
    />
    <div className="qty-spin">
      <button
        type="button"
        className="qty-spin-btn"
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
        className="qty-spin-btn"
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
      className="btn-remove-cell"
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
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
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
		const tradingViewSymbol = getTradingViewTickerTagSymbol(row, {
			allowFunds: true,
		});
		if (isNonUsLookthroughRow(row) || !tradingViewSymbol) {
			const label = getTickerCellLabel(row);
			return html`<span className="ticker-name-cell" title=${val}>
				<span className="ticker-name-primary">${label}</span>
			</span>`;
		}
		return html`<tv-ticker-tag
			className="ticker-tag-compact"
      symbol=${tradingViewSymbol}
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
		content = html`<span className=${`badge ${badgeClass}`}
      >${formatCellValue(row, col)}</span
    >`;
	} else if (
		format === "percent_neutral" &&
		key === "weight_pct" &&
		row.etf_lookthrough_only
	) {
		content = html`<span className="cell-weight">--</span>`;
	} else if (format === "percent_neutral") {
		content = html`<span className="cell-weight"
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
		content = html`<span className=${scoreClass}
      >${formatCellValue(row, col)}</span
    >`;
	} else {
		content = formatCellValue(row, col);
	}

	if (isProxiedStatCell(row, key)) {
		content = html`<span
			className="cell-proxied-stat"
			title="Proxied from ETF top holdings"
			>${content}</span
		>`;
	}

	// Apply conditional coloring
	const colorKey = col.key;
	const isColorizable =
		!PLAIN_ALLOCATION_COLUMNS.has(colorKey) &&
		(["score", "percent_neutral", "number", "market_cap"].includes(format) ||
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
	isLoading = false,
	animateRows = true,
}) {
	const scrollRef = useRef(null);
	const rafRef = useRef(null);
	const virtualStartRef = useRef(0);
	const virtualViewportHeightRef = useRef(VIRTUAL_INITIAL_VIEWPORT_HEIGHT);
	const hasScrolledRef = useRef(false);
	const [virtualStart, setVirtualStart] = useState(0);
	const [virtualViewportHeight, setVirtualViewportHeight] = useState(
		VIRTUAL_INITIAL_VIEWPORT_HEIGHT,
	);
	const [scrollState, setScrollState] = useState(() => getScrollState(null));
	const cols = COLS[tab];
	const isEvaluationTab = tab === "evaluations";

	const filtered = useMemo(
		() => rows.filter((row) => rowBelongsToTab(row, tab)),
		[rows, tab],
	);

	const sorted = useMemo(
		() => sortRows(filtered, sortCol, sortDir),
		[filtered, sortCol, sortDir],
	);
	const virtualWindow = getVirtualWindow({
		rowCount: sorted.length,
		start: virtualStart,
		viewportHeight: virtualViewportHeight,
	});
	const visibleRows = sorted.slice(virtualWindow.start, virtualWindow.end);
	const shouldAnimateRows =
		animateRows && virtualStart === 0 && !hasScrolledRef.current;

	const hasRows = sorted.length > 0;
	const shouldShowLoadingRows = isLoading && !hasRows;
	const skeletonRows = useMemo(() => Array.from({ length: 10 }), []);
	const tickerCharCount = getColumnCharCount(
		sorted.map((row) => getTickerDisplayValue(row.ticker)),
		"TICKER",
	);
	const columnCharCounts = getColumnCharCounts(sorted, cols);
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
		scrollState.hasOverflowX ? "has-overflow-x" : "",
		scrollState.isScrolledX ? "is-scrolled-x" : "",
		scrollState.hasMoreX ? "has-more-x" : "",
	]
		.filter(Boolean)
		.join(" ");
	const tableClassName = [
		"data-table",
		isEvaluationTab ? "data-table-evaluations" : "",
	]
		.filter(Boolean)
		.join(" ");
	const tableResetKey = `${tab}:${sortCol}:${sortDir}`;

	useEffect(() => {
		const scrollEl = scrollRef.current;
		if (!scrollEl) return;

		const updateViewportHeight = () => {
			const nextHeight = scrollEl.clientHeight || VIRTUAL_ROW_HEIGHT_PX;
			virtualViewportHeightRef.current = nextHeight;
			setVirtualViewportHeight(nextHeight);
			syncScrollState(setScrollState, scrollEl);
		};

		updateViewportHeight();

		window.addEventListener("resize", updateViewportHeight);
		window.visualViewport?.addEventListener("resize", updateViewportHeight);
		return () => {
			window.removeEventListener("resize", updateViewportHeight);
			window.visualViewport?.removeEventListener(
				"resize",
				updateViewportHeight,
			);
		};
	}, []);

	useEffect(() => {
		const scrollEl = scrollRef.current;
		if (!scrollEl) return;
		syncScrollState(setScrollState, scrollEl);
	});

	useEffect(() => {
		const scrollEl = scrollRef.current;
		if (!scrollEl) return;
		scrollEl.dataset.resetKey = tableResetKey;

		scrollEl.scrollTop = 0;
		virtualStartRef.current = 0;
		hasScrolledRef.current = false;
		setVirtualStart(0);
	}, [tableResetKey]);

	useEffect(() => {
		return () => {
			if (rafRef.current != null) {
				cancelAnimationFrame(rafRef.current);
			}
		};
	}, []);

	function handleScroll(event) {
		syncScrollState(setScrollState, event.currentTarget);

		const nextScrollTop = event.currentTarget.scrollTop;
		if (nextScrollTop > 0) {
			hasScrolledRef.current = true;
		}
		if (rafRef.current != null) return;

		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = null;
			const currentStart = virtualStartRef.current;
			const nextStart = getNextVirtualStart({
				currentStart,
				scrollTop: nextScrollTop,
				viewportHeight: virtualViewportHeightRef.current,
			});
			if (nextStart === currentStart) return;

			virtualStartRef.current = nextStart;
			setVirtualStart(nextStart);
		});
	}

	return html`
		<div className="table-shell">
			<div
				ref=${scrollRef}
				className=${tableWrapperClassName}
				style=${tableWrapperStyle}
				onScroll=${handleScroll}
			>
				<table id="main-table" className=${tableClassName}>
					<colgroup>
						${cols.map((col) => {
							const className = [
								getColumnClassName(col.key),
								getColumnClusterClassName(col.cluster),
							]
								.filter(Boolean)
								.join(" ");
							return html`<col
								key=${col.key}
								className=${className}
								style=${
									col.key === "ticker"
										? null
										: getColumnWidthStyle(
												columnCharCounts[col.key],
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
									return html`<th key=${c.key} className=${columnClassName}></th>`;
								const sortedClass =
									sortCol === c.key ? `sorted ${sortDir}` : "";
								return html`<th
									key=${c.key}
									data-sort=${c.key}
									className=${`${columnClassName} ${sortedClass}`.trim()}
									aria-sort=${getAriaSort(sortCol, sortDir, c.key)}
								>
									<button
										type="button"
										className="table-sort-btn"
										data-tooltip=${c.tooltip || c.label}
										data-description=${c.description || ""}
										onClick=${() => onSort(c.key)}
									>
										<span>${c.label}</span>
										<span className="sort-indicator" aria-hidden="true"></span>
										<span className="table-header-tooltip" aria-hidden="true">
											<span className="table-header-tooltip-title">
												${c.tooltip || c.label}
											</span>
											${
												c.description
													? html`<span className="table-header-tooltip-description">
															${c.description}
														</span>`
													: null
											}
											${
												c.tooltipRows?.length
													? html`<span className="table-header-tooltip-rows">
															${c.tooltipRows.map(
																(row) => html`
																	<span
																		key=${row.label}
																		className="table-header-tooltip-row"
																	>
																		<span>${row.label}</span>
																		<span>${row.value}</span>
																	</span>
																`,
															)}
														</span>`
													: null
											}
										</span>
									</button>
								</th>`;
							})}
						</tr>
					</thead>
					<tbody>
						${
							shouldShowLoadingRows
								? skeletonRows.map(
										(_, rowIndex) => html`<tr
											key=${`loading-${rowIndex}`}
											className="table-skeleton-row"
										>
											${cols.map(
												(col, colIndex) => html`<td key=${col.key}>
													<span
														className=${`table-skeleton-cell ${
															colIndex === 0 ? "is-ticker" : ""
														}`}
													></span>
												</td>`,
											)}
										</tr>`,
									)
								: null
						}
						${
							hasRows
								? html`
										${
											virtualWindow.topPadding > 0
												? html`<tr key="top-spacer" className="virtual-spacer-row">
														<td
															colSpan=${cols.length}
															style=${{
																height: `${virtualWindow.topPadding}px`,
															}}
														></td>
													</tr>`
												: null
										}
										${visibleRows.map((row, rowOffset) => {
											const rowIndex = virtualWindow.start + rowOffset;
											return html`<tr
												key=${normalizeTicker(row.ticker)}
												className=${shouldAnimateRows ? "animate-in" : ""}
												style=${
													shouldAnimateRows
														? {
																animationDelay: `${Math.min(rowIndex, 12) * CONFIG.animationDelayMs}ms`,
															}
														: null
												}
											>
												${cols.map(
													(col) =>
														html`<td
															key=${col.key}
															className=${[
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
											</tr>`;
										})}
										${
											virtualWindow.bottomPadding > 0
												? html`<tr key="bottom-spacer" className="virtual-spacer-row">
														<td
															colSpan=${cols.length}
															style=${{
																height: `${virtualWindow.bottomPadding}px`,
															}}
														></td>
													</tr>`
												: null
										}
									`
								: null
						}
						${
							hasRows || shouldShowLoadingRows
								? null
								: html`
										<tr key="empty-row" className="table-empty-row">
											<td colSpan=${cols.length}>
												<div className="table-empty-state">
													<div className="table-empty-title">No rows in this view</div>
													<div className="table-empty-copy">
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
