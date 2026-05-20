import { html } from "htm/react";
import {
	Children,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { calculateScoreColorMetadata } from "../../color.js";
import {
	COLS,
	CONFIG,
	NOTIONAL_COLUMN_KEYS,
	WIDTH_GROUP_OPTIONS,
} from "../../config.js";
import { normalizeTicker, parseMarketCap } from "../../format.js";
import {
	getColumnCharCount,
	getColumnWidthStyle,
	renderConditionallyColoredValue,
} from "../../tableStyle.js";
import { getTradingViewTickerTagSymbol } from "../../tradingViewSymbols.js";
import {
	formatCellValue,
	getAriaSort,
	getColumnCharCounts,
	getColumnClassName,
	getColumnClusterClassName,
	getTickerCellLabel,
	getTickerDisplayValue,
	isDerivedStatCell,
	isGeneratedNotionalOnlyRow,
	isNonUsLookthroughRow,
	isProxiedStatCell,
	normalizeSearchText,
	rowBelongsToTab,
	rowMatchesNormalizedSearch,
	sortRows,
} from "./dataModel.js";
import { useQuantityCellState } from "./useQuantityCellState.js";

const PLAIN_ALLOCATION_COLUMNS = new Set([
	"total",
	"notional_value",
	"weight_pct",
	"notional_weight_pct",
]);
const TABLE_ROW_HEIGHT_PX = 28;
const ROW_WINDOW_OVERSCAN = 12;
const ROW_WINDOW_INITIAL_COUNT = 64;
const HEADER_TOOLTIP_HALF_WIDTH_PX = 130;
const HEADER_TOOLTIP_OFFSET_PX = 6;
const SCROLL_SYNC_THRESHOLD_PX = 1;
const PORTFOLIO_SUMMARY_TICKER = "__PORTFOLIO_SUMMARY__";
const SUMMARY_BLANK_COLUMNS = new Set([
	"ticker",
	"price",
	"rank",
	"strategy",
	"notional_value",
	"weight_pct",
	"notional_weight_pct",
	"quantity",
	"remove",
]);
const SUMMARY_RETURN_PERCENT_COLUMNS = new Set([
	"change_percent_1d",
	"change_percent_1m",
	"change_percent_3m",
	"change_percent_6m",
	"change_percent_1y",
]);

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

function getVisibleRowWindow(wrapperEl, rowCount) {
	if (!wrapperEl || rowCount <= 0) {
		return { start: 0, end: 0 };
	}

	const wrapperTop = window.scrollY + wrapperEl.getBoundingClientRect().top;
	const viewportTop = window.scrollY;
	const viewportBottom = viewportTop + window.innerHeight;
	const start = Math.min(
		rowCount,
		Math.max(
			0,
			Math.floor((viewportTop - wrapperTop) / TABLE_ROW_HEIGHT_PX) -
				ROW_WINDOW_OVERSCAN,
		),
	);
	const end = Math.min(
		rowCount,
		Math.max(
			0,
			Math.ceil((viewportBottom - wrapperTop) / TABLE_ROW_HEIGHT_PX) +
				ROW_WINDOW_OVERSCAN,
		),
	);

	if (end <= start) {
		const fallbackStart = Math.max(
			0,
			Math.min(start, rowCount - ROW_WINDOW_INITIAL_COUNT),
		);
		const fallbackEnd = Math.min(
			rowCount,
			fallbackStart + ROW_WINDOW_INITIAL_COUNT,
		);
		return { start: fallbackStart, end: fallbackEnd };
	}

	return { start, end };
}

function rowWindowEqual(a, b) {
	return a.start === b.start && a.end === b.end;
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
	} = useQuantityCellState({
		row,
		isUsingDemoData,
		onSetQuantity,
	});

	return html`<div className="qty-control">
    <input
      className="qty-input"
      type="number"
      inputMode="numeric"
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

function finiteNumber(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

function weightedAverage(rows, fieldName) {
	let weightedSum = 0;
	let totalWeight = 0;

	for (const row of rows) {
		const total = finiteNumber(row.total);
		const value = finiteNumber(row[fieldName]);
		if (total == null || total <= 0 || value == null) continue;

		weightedSum += total * value;
		totalWeight += total;
	}

	return totalWeight > 0 ? weightedSum / totalWeight : null;
}

function weightedReturnPercent(rows, fieldName) {
	let currentValue = 0;
	let priorValue = 0;

	for (const row of rows) {
		const total = finiteNumber(row.total);
		const changePercent = finiteNumber(row[fieldName]);
		if (total == null || total <= 0 || changePercent == null) continue;

		const returnMultiple = 1 + changePercent / 100;
		if (returnMultiple <= 0) continue;

		currentValue += total;
		priorValue += total / returnMultiple;
	}

	return priorValue > 0
		? ((currentValue - priorValue) / priorValue) * 100
		: null;
}

function buildTopSectorTooltipRows(sectorDistribution) {
	return (Array.isArray(sectorDistribution) ? sectorDistribution : [])
		.map((sectorRow) => ({
			label: String(sectorRow?.sector || "").trim(),
			value: finiteNumber(sectorRow?.portfolio_weight),
		}))
		.filter(
			(sectorRow) =>
				sectorRow.label &&
				sectorRow.value != null &&
				Math.round(sectorRow.value) > 0,
		)
		.sort((left, right) => right.value - left.value)
		.map((sectorRow) => ({
			label: sectorRow.label,
			value: `${sectorRow.value.toFixed(0)}%`,
		}));
}

function buildPortfolioSummaryRow(rows, stats, cols, tab) {
	if (tab === "evaluations") return null;

	const heldRows = rows.filter((row) => {
		const quantity = finiteNumber(row.quantity);
		const total = finiteNumber(row.total);
		return quantity != null && quantity > 0 && total != null && total > 0;
	});
	if (heldRows.length === 0) return null;

	const summaryRow = {
		ticker: PORTFOLIO_SUMMARY_TICKER,
		name: "Portfolio",
		is_portfolio_summary: true,
		top_sector_rows: buildTopSectorTooltipRows(stats?.sectorDistribution),
		total: finiteNumber(stats?.totalVal),
		beta: finiteNumber(stats?.weightedBeta),
		iv: finiteNumber(stats?.weightedIv),
	};

	const changePercent = finiteNumber(stats?.change?.percent);
	if (changePercent != null) {
		summaryRow.change_percent_1d = changePercent;
	}

	for (const col of cols) {
		if (
			Object.hasOwn(summaryRow, col.key) ||
			SUMMARY_BLANK_COLUMNS.has(col.key)
		) {
			continue;
		}
		summaryRow[col.key] = SUMMARY_RETURN_PERCENT_COLUMNS.has(col.key)
			? weightedReturnPercent(heldRows, col.key)
			: weightedAverage(heldRows, col.key);
	}

	return summaryRow;
}

function renderCell({
	row,
	col,
	colorMeta,
	onRemove,
	onSetQuantity,
	isUsingDemoData,
	onShowTooltip,
	onHideTooltip,
}) {
	const key = col.key;
	const format = col.format;

	if (row.is_portfolio_summary) {
		if (key === "ticker") {
			const tooltipRows = Array.isArray(row.top_sector_rows)
				? row.top_sector_rows
				: [];
			const portfolioTooltip = {
				tooltip: "Portfolio weighted summary",
				description: "Value-weighted by holdings.",
				tooltipRows,
				className: "portfolio-summary-tooltip",
			};
			return html`<span
				className="ticker-name-cell portfolio-summary-ticker"
				tabIndex="0"
				onMouseEnter=${(event) => onShowTooltip?.(portfolioTooltip, event)}
				onMouseLeave=${onHideTooltip}
				onFocus=${(event) => onShowTooltip?.(portfolioTooltip, event)}
				onBlur=${onHideTooltip}
			>
				<span className="ticker-name-primary">PORTFOLIO</span>
			</span>`;
		}
		if (SUMMARY_BLANK_COLUMNS.has(key)) {
			return "";
		}
	}

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
      aria-label=${`Remove ${getTickerDisplayValue(row.ticker)}`}
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

	if (isDerivedStatCell(row, key)) {
		content = html`<span
			className="cell-derived-stat"
			title="Derived from PE and NTM forward PE"
			>${content}</span
		>`;
	}

	// Apply conditional coloring
	const colorKey = col.key;
	const isColorizable =
		!PLAIN_ALLOCATION_COLUMNS.has(colorKey) &&
		!row.is_portfolio_summary &&
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

export function Table({
	tab,
	rows,
	stats = null,
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
	tableDisplayOptions = CONFIG.tableDisplayDefaults,
}) {
	const scrollRef = useRef(null);
	const bodyTableRef = useRef(null);
	const headerScrollRef = useRef(null);
	const summaryScrollRef = useRef(null);
	const lastJumpQueryRef = useRef("");
	const mirroredScrollTargetRef = useRef(null);
	const [scrollState, setScrollState] = useState(() => getScrollState(null));
	const [headerTooltip, setHeaderTooltip] = useState(null);
	const [rowWindow, setRowWindow] = useState(() => ({
		start: 0,
		end: ROW_WINDOW_INITIAL_COUNT,
	}));
	const [headerColumnWidths, setHeaderColumnWidths] = useState([]);
	const rawCols = COLS[tab];
	const showNotional =
		tableDisplayOptions?.showNotional ??
		CONFIG.tableDisplayDefaults.showNotional;
	const cols = useMemo(
		() =>
			showNotional
				? rawCols
				: rawCols.filter((col) => !NOTIONAL_COLUMN_KEYS.includes(col.key)),
		[rawCols, showNotional],
	);
	const isEvaluationTab = tab === "evaluations";

	const filtered = useMemo(
		() =>
			rows.filter(
				(row) =>
					rowBelongsToTab(row, tab) &&
					(showNotional || !isGeneratedNotionalOnlyRow(row)),
			),
		[rows, tab, showNotional],
	);

	const sorted = useMemo(
		() => sortRows(filtered, sortCol, sortDir),
		[filtered, sortCol, sortDir],
	);
	const portfolioSummaryRow = useMemo(
		() => buildPortfolioSummaryRow(rows, stats, cols, tab),
		[cols, rows, stats, tab],
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
	const tickerCharCount = useMemo(
		() =>
			getColumnCharCount(
				sorted.map((row) => getTickerDisplayValue(row.ticker)),
				"TICKER",
			),
		[sorted],
	);
	const columnCharCounts = useMemo(
		() => getColumnCharCounts(sorted, cols),
		[sorted, cols],
	);
	const colorMeta = useMemo(
		() =>
			calculateScoreColorMetadata(sorted, cols, {
				colorBandFraction: CONFIG.colorBandFraction,
				keyStandards: colorStandards,
			}),
		[sorted, cols, colorStandards],
	);
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
	const headerTableWidth = headerColumnWidths.reduce(
		(totalWidth, width) => totalWidth + width,
		0,
	);
	const headerTableStyle = headerTableWidth
		? {
				width: `${headerTableWidth}px`,
				minWidth: `${headerTableWidth}px`,
				maxWidth: `${headerTableWidth}px`,
			}
		: null;
	const tableLayoutKey = `${tab}:${cols.map((col) => col.key).join(",")}`;
	const effectiveRowWindow = {
		start: Math.min(rowWindow.start, sorted.length),
		end: Math.min(Math.max(rowWindow.end, rowWindow.start), sorted.length),
	};
	const visibleRows = sorted.slice(
		effectiveRowWindow.start,
		effectiveRowWindow.end,
	);
	const topSpacerHeight = effectiveRowWindow.start * TABLE_ROW_HEIGHT_PX;
	const bottomSpacerHeight =
		(sorted.length - effectiveRowWindow.end) * TABLE_ROW_HEIGHT_PX;
	const getBaseColumnStyle = (col) =>
		col.key === "ticker"
			? null
			: getColumnWidthStyle(
					columnCharCounts[col.key],
					WIDTH_GROUP_OPTIONS[col.widthGroup] ?? {},
				);
	const getMeasuredColumnStyle = (col, colIndex) => {
		const width = headerColumnWidths[colIndex];
		if (!width) return getBaseColumnStyle(col);

		const widthPx = `${width}px`;
		return {
			width: widthPx,
			minWidth: widthPx,
			maxWidth: widthPx,
		};
	};
	const renderColGroup = ({ useMeasuredWidths = false } = {}) =>
		html`<colgroup key="colgroup">
		${Children.toArray(
			cols.map((col, colIndex) => {
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
						useMeasuredWidths
							? getMeasuredColumnStyle(col, colIndex)
							: getBaseColumnStyle(col)
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
	const markMirroredScrollTarget = useCallback((targetName) => {
		mirroredScrollTargetRef.current = targetName;
		requestAnimationFrame(() => {
			if (mirroredScrollTargetRef.current === targetName) {
				mirroredScrollTargetRef.current = null;
			}
		});
	}, []);
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
		const resizeObserver =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(updateScrollState);
		resizeObserver?.observe(scrollEl);
		return () => {
			window.removeEventListener("resize", updateScrollState);
			window.visualViewport?.removeEventListener("resize", updateScrollState);
			resizeObserver?.disconnect();
		};
	}, []);

	useEffect(() => {
		const scrollEl = scrollRef.current;
		let animationFrameId = 0;

		const updateRowWindow = () => {
			window.cancelAnimationFrame(animationFrameId);
			animationFrameId = window.requestAnimationFrame(() => {
				const nextWindow = getVisibleRowWindow(scrollEl, sorted.length);
				setRowWindow((currentWindow) =>
					rowWindowEqual(currentWindow, nextWindow)
						? currentWindow
						: nextWindow,
				);
			});
		};

		updateRowWindow();
		window.addEventListener("scroll", updateRowWindow, { passive: true });
		window.addEventListener("resize", updateRowWindow);
		window.visualViewport?.addEventListener("resize", updateRowWindow);

		return () => {
			window.cancelAnimationFrame(animationFrameId);
			window.removeEventListener("scroll", updateRowWindow);
			window.removeEventListener("resize", updateRowWindow);
			window.visualViewport?.removeEventListener("resize", updateRowWindow);
		};
	}, [sorted.length]);

	useLayoutEffect(() => {
		const tableEl = bodyTableRef.current;
		if (!tableEl || !hasRows) {
			setHeaderColumnWidths((currentWidths) =>
				currentWidths.length === 0 ? currentWidths : [],
			);
			return;
		}

		const firstDataRow = tableEl.querySelector(
			"tbody tr:not(.portfolio-summary-row):not(.table-virtual-spacer):not(.table-empty-row)",
		);
		const nextWidths = Array.from(firstDataRow?.children || []).map(
			(cell) => Math.round(cell.getBoundingClientRect().width * 100) / 100,
		);
		if (nextWidths.length !== cols.length) return;

		setHeaderColumnWidths((currentWidths) => {
			const isSameWidthSet =
				currentWidths.length === nextWidths.length &&
				currentWidths.every(
					(width, index) => Math.abs(width - nextWidths[index]) < 0.5,
				);
			return isSameWidthSet ? currentWidths : nextWidths;
		});
	});

	useLayoutEffect(() => {
		const scrollEl = scrollRef.current;
		const headerScrollEl = headerScrollRef.current;
		const summaryScrollEl = summaryScrollRef.current;
		if (!scrollEl || !headerScrollEl || !headerColumnWidths.length) return;

		headerScrollEl.scrollLeft = scrollEl.scrollLeft;
		if (summaryScrollEl) {
			summaryScrollEl.scrollLeft = scrollEl.scrollLeft;
		}
	}, [headerColumnWidths]);

	useEffect(() => {
		const scrollEl = scrollRef.current;
		const headerScrollEl = headerScrollRef.current;
		const summaryScrollEl = summaryScrollRef.current;
		if (!scrollEl) return;

		const handleWheel = (event) => {
			if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
			if (getMaxScrollLeft(scrollEl) <= 0) return;

			event.preventDefault();

			const nextScrollLeft = getNextScrollLeft(scrollEl, event.deltaX);
			if (nextScrollLeft === scrollEl.scrollLeft) return;

			scrollEl.scrollLeft = nextScrollLeft;
			markMirroredScrollTarget("header");
			syncHorizontalScroll(scrollEl, headerScrollEl);
			syncHorizontalScroll(scrollEl, summaryScrollEl);
			syncScrollState(setScrollState, scrollEl);
		};
		const wheelOptions = { passive: false };

		scrollEl.addEventListener("wheel", handleWheel, wheelOptions);
		headerScrollEl?.addEventListener("wheel", handleWheel, wheelOptions);
		summaryScrollEl?.addEventListener("wheel", handleWheel, wheelOptions);
		return () => {
			scrollEl.removeEventListener("wheel", handleWheel, wheelOptions);
			headerScrollEl?.removeEventListener("wheel", handleWheel, wheelOptions);
			summaryScrollEl?.removeEventListener("wheel", handleWheel, wheelOptions);
		};
	}, [markMirroredScrollTarget]);

	useEffect(() => {
		const scrollEl = scrollRef.current;
		if (!scrollEl) return;
		scrollEl.dataset.layoutKey = tableLayoutKey;

		scrollEl.scrollTop = 0;
		scrollEl.scrollLeft = 0;
		if (headerScrollRef.current) {
			headerScrollRef.current.scrollLeft = 0;
		}
		if (summaryScrollRef.current) {
			summaryScrollRef.current.scrollLeft = 0;
		}
	}, [tableLayoutKey]);

	useEffect(() => {
		if (!normalizedSearchQuery || targetRowIndex < 0) return;

		const jumpKey = `${normalizedSearchQuery}:${targetRowIndex}`;
		if (lastJumpQueryRef.current === jumpKey) return;
		lastJumpQueryRef.current = jumpKey;

		const scrollEl = scrollRef.current;
		if (!scrollEl) return;

		requestAnimationFrame(() => {
			const rowTop =
				window.scrollY +
				scrollEl.getBoundingClientRect().top +
				targetRowIndex * TABLE_ROW_HEIGHT_PX;
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
		if (mirroredScrollTargetRef.current === "body") {
			mirroredScrollTargetRef.current = null;
			return;
		}
		hideHeaderTooltip();
		if (headerScrollEl) {
			markMirroredScrollTarget("header");
			const didSync = syncHorizontalScroll(scrollEl, headerScrollEl);
			if (!didSync) {
				mirroredScrollTargetRef.current = null;
			}
		}
		syncHorizontalScroll(scrollEl, summaryScrollRef.current);
		syncScrollState(setScrollState, scrollEl);
	}

	function handleMirroredTableScroll(event, targetName) {
		const sourceEl = event.currentTarget;
		const scrollEl = scrollRef.current;
		const headerScrollEl = headerScrollRef.current;
		const summaryScrollEl = summaryScrollRef.current;
		if (mirroredScrollTargetRef.current === targetName) {
			mirroredScrollTargetRef.current = null;
			return;
		}
		hideHeaderTooltip();
		if (!scrollEl) return;

		markMirroredScrollTarget("body");
		const didSync = syncHorizontalScroll(sourceEl, scrollEl);
		if (targetName !== "header") {
			syncHorizontalScroll(sourceEl, headerScrollEl);
		}
		if (targetName !== "summary") {
			syncHorizontalScroll(sourceEl, summaryScrollEl);
		}
		if (!didSync) {
			mirroredScrollTargetRef.current = null;
		}
		syncScrollState(setScrollState, scrollEl);
	}

	function handleHeaderScroll(event) {
		handleMirroredTableScroll(event, "header");
	}

	function handleSummaryScroll(event) {
		handleMirroredTableScroll(event, "summary");
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
							row.is_portfolio_summary ? "portfolio-summary-cell" : "",
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
						onShowTooltip: showHeaderTooltip,
						onHideTooltip: hideHeaderTooltip,
					})}
				</td>`,
			),
		);

	const renderSpacerRow = (key, height) =>
		height > 0
			? html`<tr key=${key} className="table-virtual-spacer" aria-hidden="true">
					<td colSpan=${cols.length} style=${{ height: `${height}px` }}></td>
				</tr>`
			: null;

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

	const portfolioSummaryTable = portfolioSummaryRow
		? html`<div
				key="portfolio-summary"
				ref=${summaryScrollRef}
				className="table-portfolio-summary"
				style=${tableWrapperStyle}
				onScroll=${handleSummaryScroll}
			>
				<table
					className=${`${tableClassName} data-table-summary`}
					style=${headerTableStyle}
				>
					${renderColGroup({ useMeasuredWidths: true })}
					<tbody>
						<tr
							className="portfolio-summary-row"
							aria-label="Portfolio weighted summary"
						>
							${renderTableCells(portfolioSummaryRow)}
						</tr>
					</tbody>
				</table>
			</div>`
		: null;

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
				? [
						renderSpacerRow("top-spacer", topSpacerHeight),
						...visibleRows.map((row, visibleRowIndex) => {
							const rowIndex = effectiveRowWindow.start + visibleRowIndex;
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
						}),
						renderSpacerRow("bottom-spacer", bottomSpacerHeight),
					]
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
					style=${headerTableStyle}
				>
					${renderColGroup({ useMeasuredWidths: true })}
					<thead key="header-head">
						<tr>${renderHeaderCells()}</tr>
					</thead>
				</table>
			</div>
			${
				headerTooltip
					? html`<div
							key="header-tooltip"
							className=${[
								"table-header-tooltip",
								"table-header-tooltip-floating",
								headerTooltip.col.className,
							]
								.filter(Boolean)
								.join(" ")}
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
			${portfolioSummaryTable}
			<div
				key="table-wrapper"
				ref=${scrollRef}
				className=${tableWrapperClassName}
				style=${tableWrapperStyle}
				onScroll=${handleScroll}
			>
				<table id="main-table" ref=${bodyTableRef} className=${tableClassName}>
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
