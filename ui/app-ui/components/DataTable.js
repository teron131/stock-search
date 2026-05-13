import { html } from "htm/react";
import { Children, useEffect, useMemo, useRef, useState } from "react";

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
const TABLE_ROW_HEIGHT_PX = 28;
const HEADER_TOOLTIP_HALF_WIDTH_PX = 130;
const HEADER_TOOLTIP_OFFSET_PX = 6;
const SCROLL_SYNC_THRESHOLD_PX = 1;

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

function normalizeSearchText(value) {
	return String(value ?? "")
		.trim()
		.toUpperCase();
}

function rowMatchesNormalizedSearch(row, normalizedQuery) {
	const ticker = normalizeSearchText(row?.ticker);
	const displayTicker = normalizeSearchText(getTickerDisplayValue(row?.ticker));
	const label = normalizeSearchText(getTickerCellLabel(row));
	const name = normalizeSearchText(row?.name);

	return [ticker, displayTicker, label, name].some((value) =>
		value.includes(normalizedQuery),
	);
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
			scrollLeft: 0,
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
		scrollLeft,
	};
}

function statesEqual(a, b) {
	return (
		a.hasOverflowX === b.hasOverflowX &&
		a.isScrolledX === b.isScrolledX &&
		a.hasMoreX === b.hasMoreX &&
		a.scrollLeft === b.scrollLeft
	);
}

function syncScrollState(setScrollState, scrollEl) {
	const nextState = getScrollState(scrollEl);
	setScrollState((currentState) =>
		statesEqual(currentState, nextState) ? currentState : nextState,
	);
}

function getMaxScrollLeft(scrollEl) {
	return Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
}

function getNextScrollLeft(scrollEl, deltaX) {
	const maxScrollLeft = getMaxScrollLeft(scrollEl);
	return Math.min(Math.max(scrollEl.scrollLeft + deltaX, 0), maxScrollLeft);
}

function mapScrollLeft(sourceEl, targetEl) {
	const sourceMax = getMaxScrollLeft(sourceEl);
	const targetMax = getMaxScrollLeft(targetEl);
	if (sourceMax <= 0 || targetMax <= 0) return 0;
	return (sourceEl.scrollLeft / sourceMax) * targetMax;
}

function syncHorizontalScroll(sourceEl, targetEl) {
	if (!targetEl) return false;

	const nextScrollLeft = mapScrollLeft(sourceEl, targetEl);
	if (
		Math.abs(targetEl.scrollLeft - nextScrollLeft) <= SCROLL_SYNC_THRESHOLD_PX
	) {
		return false;
	}

	targetEl.scrollLeft = nextScrollLeft;
	return true;
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
		if (col.key === "ticker" || col.key === "remove") {
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
	searchQuery = "",
}) {
	const scrollRef = useRef(null);
	const headerScrollRef = useRef(null);
	const lastJumpQueryRef = useRef("");
	const [scrollState, setScrollState] = useState(() => getScrollState(null));
	const [headerTooltip, setHeaderTooltip] = useState(null);
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
	const normalizedSearchQuery = normalizeSearchText(searchQuery);
	const targetRowIndex = useMemo(() => {
		if (!normalizedSearchQuery) return -1;
		return sorted.findIndex((row) =>
			rowMatchesNormalizedSearch(row, normalizedSearchQuery),
		);
	}, [sorted, normalizedSearchQuery]);
	const shouldAnimateRows = animateRows && !searchQuery;

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
		"table-wrapper-window-scroll",
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
	const renderColGroup = () => html`<colgroup key="colgroup">
		${Children.toArray(
			cols.map((col) => {
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
									WIDTH_GROUP_OPTIONS[col.widthGroup] ?? {},
								)
					}
				/>`;
			}),
		)}
	</colgroup>`;
	const renderHeaderTooltip = (c) => html`
		<span key="title" className="table-header-tooltip-title">
			${c.tooltip || c.label}
		</span>
		${
			c.description
				? html`<span key="description" className="table-header-tooltip-description">
						${c.description}
					</span>`
				: null
		}
		${
			c.tooltipRows?.length
				? html`<span key="rows" className="table-header-tooltip-rows">
						${Children.toArray(
							c.tooltipRows.map(
								(row, rowIndex) => html`
									<span
										key=${`${row.label}:${rowIndex}`}
										className="table-header-tooltip-row"
									>
										<span>${row.label}</span>
										<span>${row.value}</span>
									</span>
								`,
							),
						)}
					</span>`
				: null
		}
	`;
	const showHeaderTooltip = (c, event) => {
		const rect = event.currentTarget.getBoundingClientRect();
		setHeaderTooltip({
			col: c,
			left: Math.min(
				Math.max(rect.left + rect.width / 2, HEADER_TOOLTIP_HALF_WIDTH_PX),
				window.innerWidth - HEADER_TOOLTIP_HALF_WIDTH_PX,
			),
			top: rect.bottom + HEADER_TOOLTIP_OFFSET_PX,
		});
	};
	const hideHeaderTooltip = () => setHeaderTooltip(null);
	const renderHeaderCells = () =>
		Children.toArray(
			cols.map((c) => {
				const columnClassName = [
					getColumnClassName(c.key),
					getColumnClusterClassName(c.cluster),
				]
					.filter(Boolean)
					.join(" ");
				if (c.key === "remove")
					return html`<th key=${c.key} className=${columnClassName}></th>`;
				const sortedClass = sortCol === c.key ? `sorted ${sortDir}` : "";
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
					onMouseEnter=${(event) => showHeaderTooltip(c, event)}
					onMouseLeave=${hideHeaderTooltip}
					onFocus=${(event) => showHeaderTooltip(c, event)}
					onBlur=${hideHeaderTooltip}
					onClick=${() => onSort(c.key)}
				>
					<span key="label">${c.label}</span>
					<span
						key="sort-indicator"
						className="sort-indicator"
						aria-hidden="true"
					></span>
					<span
						key="tooltip"
						className="table-header-tooltip"
						aria-hidden="true"
					>
						${renderHeaderTooltip(c)}
					</span>
				</button>
			</th>`;
			}),
		);

	useEffect(() => {
		const scrollEl = scrollRef.current;
		if (!scrollEl) return;

		const updateScrollState = () => {
			syncScrollState(setScrollState, scrollEl);
		};

		updateScrollState();

		window.addEventListener("resize", updateScrollState);
		window.visualViewport?.addEventListener("resize", updateScrollState);
		return () => {
			window.removeEventListener("resize", updateScrollState);
			window.visualViewport?.removeEventListener("resize", updateScrollState);
		};
	}, []);

	useEffect(() => {
		const scrollEl = scrollRef.current;
		const headerScrollEl = headerScrollRef.current;
		if (!scrollEl) return;

		const handleWheel = (event) => {
			if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;

			const nextScrollLeft = getNextScrollLeft(scrollEl, event.deltaX);
			if (nextScrollLeft === scrollEl.scrollLeft) return;

			event.preventDefault();
			scrollEl.scrollLeft = nextScrollLeft;
			syncHorizontalScroll(scrollEl, headerScrollEl);
			syncScrollState(setScrollState, scrollEl);
		};
		const wheelOptions = { passive: false };

		scrollEl.addEventListener("wheel", handleWheel, wheelOptions);
		headerScrollEl?.addEventListener("wheel", handleWheel, wheelOptions);
		return () => {
			scrollEl.removeEventListener("wheel", handleWheel, wheelOptions);
			headerScrollEl?.removeEventListener("wheel", handleWheel, wheelOptions);
		};
	}, []);

	useEffect(() => {
		const scrollEl = scrollRef.current;
		if (!scrollEl) return;
		scrollEl.dataset.resetKey = tableResetKey;

		scrollEl.scrollTop = 0;
		scrollEl.scrollLeft = 0;
		if (headerScrollRef.current) {
			headerScrollRef.current.scrollLeft = 0;
		}
	}, [tableResetKey]);

	useEffect(() => {
		if (!normalizedSearchQuery || targetRowIndex < 0) return;

		const jumpKey = `${normalizedSearchQuery}:${targetRowIndex}`;
		if (lastJumpQueryRef.current === jumpKey) return;
		lastJumpQueryRef.current = jumpKey;

		const scrollEl = scrollRef.current;
		if (!scrollEl) return;

		requestAnimationFrame(() => {
			const targetRow = scrollEl.querySelector(
				`tr[data-row-index="${targetRowIndex}"]`,
			);
			const rowTop =
				(targetRow?.getBoundingClientRect().top ?? 0) + window.scrollY;
			const headerOffset =
				(document.querySelector(".top-bar")?.getBoundingClientRect().height ??
					0) + TABLE_ROW_HEIGHT_PX;
			window.scrollTo({
				top: Math.max(0, rowTop - headerOffset),
				behavior: "smooth",
			});
		});
	}, [normalizedSearchQuery, targetRowIndex]);

	function handleScroll(event) {
		const scrollEl = event.currentTarget;
		const headerScrollEl = headerScrollRef.current;
		hideHeaderTooltip();
		syncHorizontalScroll(scrollEl, headerScrollEl);
		syncScrollState(setScrollState, scrollEl);
	}

	function handleHeaderScroll(event) {
		const headerScrollEl = event.currentTarget;
		const scrollEl = scrollRef.current;
		hideHeaderTooltip();
		if (scrollEl && syncHorizontalScroll(headerScrollEl, scrollEl)) {
			syncScrollState(setScrollState, scrollEl);
		}
	}

	const renderTableCells = (row) =>
		Children.toArray(
			cols.map(
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
			),
		);

	const renderSkeletonCells = () =>
		Children.toArray(
			cols.map(
				(col, colIndex) => html`<td key=${col.key}>
					<span
						className=${`table-skeleton-cell ${
							colIndex === 0 ? "is-ticker" : ""
						}`}
					></span>
				</td>`,
			),
		);

	const bodyRows = Children.toArray(
		shouldShowLoadingRows
			? skeletonRows.map(
					(_, rowIndex) => html`<tr
						key=${`loading-${rowIndex}`}
						className="table-skeleton-row"
					>
						${renderSkeletonCells()}
					</tr>`,
				)
			: hasRows
				? sorted.map((row, rowIndex) => {
						return html`<tr
							key=${`${normalizeTicker(row.ticker)}:${rowIndex}`}
							data-row-index=${rowIndex}
							data-ticker=${getTickerDisplayValue(row.ticker)}
							className=${[
								shouldAnimateRows ? "animate-in" : "",
								rowIndex === targetRowIndex ? "search-target-row" : "",
							]
								.filter(Boolean)
								.join(" ")}
							style=${
								shouldAnimateRows
									? {
											animationDelay: `${Math.min(rowIndex, 12) * CONFIG.animationDelayMs}ms`,
										}
									: null
							}
						>
							${renderTableCells(row)}
						</tr>`;
					})
				: [
						html`<tr key="empty-row" className="table-empty-row">
							<td colSpan=${cols.length}>
								<div className="table-empty-state">
									<div className="table-empty-title">No rows in this view</div>
									<div className="table-empty-copy">
										Add positions or switch tabs to inspect available ticker data.
									</div>
								</div>
							</td>
						</tr>`,
					],
	);

	return html`
		<div className="table-shell">
			<div
				key="sticky-header"
				ref=${headerScrollRef}
				className="table-sticky-header"
				style=${tableWrapperStyle}
				onScroll=${handleHeaderScroll}
			>
				<table
					className=${`${tableClassName} data-table-header-clone`}
				>
					${renderColGroup()}
					<thead key="header-head">
						<tr>${renderHeaderCells()}</tr>
					</thead>
				</table>
			</div>
			${
				headerTooltip
					? html`<div
							key="header-tooltip"
							className="table-header-tooltip table-header-tooltip-floating"
							style=${{
								left: `${headerTooltip.left}px`,
								top: `${headerTooltip.top}px`,
							}}
							aria-hidden="true"
						>
							${renderHeaderTooltip(headerTooltip.col)}
						</div>`
					: null
			}
			<div
				key="table-wrapper"
				ref=${scrollRef}
				className=${tableWrapperClassName}
				style=${tableWrapperStyle}
				onScroll=${handleScroll}
			>
				<table id="main-table" className=${tableClassName}>
					${renderColGroup()}
					<thead key="body-head" className="table-body-head">
						<tr>${renderHeaderCells()}</tr>
					</thead>
					<tbody key="body">${bodyRows}</tbody>
				</table>
			</div>
		</div>
	`;
}
