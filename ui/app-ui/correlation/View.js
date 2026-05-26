import { scaleLinear } from "d3";
import { html } from "htm/react";

import { getTradingViewTickerTagSymbol } from "../tradingViewSymbols.js";

const MODES = [
	{ value: "raw", label: "RAW" },
	{ value: "market_neutral", label: "MARKET NEUTRAL" },
];

const ICON_PATHS = {
	cluster: ["M3 5.5h4.5L9.5 9l1.6-5.5H13"],
	hedge: ["M3.5 8h3l1.5-3 2 6 1.4-3h1.1", "M3.5 12.5h9"],
	stress: ["M8 2.5 13.5 12h-11L8 2.5Z", "M8 5.8v2.8", "M8 10.5h.01"],
	basket: ["M3.5 6.5h9", "M5 6.5l1.1 6h3.8l1.1-6", "M6 4l2-2 2 2"],
	beta: ["M3.5 12.5V3.5h9", "M5 10l2-3 2 1.8 2.5-4"],
	returns: ["M3.5 11.5 6.7 8.2l2 1.8 3.8-5", "M9.6 4.5h2.9v2.9"],
};

function finiteNumber(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

function formatCorrelation(value) {
	const numeric = finiteNumber(value);
	if (numeric == null) return "--";
	return numeric.toFixed(2);
}

function parsePercent(value) {
	const numeric = Number(String(value || "").replace("%", ""));
	return Number.isFinite(numeric) ? numeric : null;
}

function renderIcon(name) {
	return html`
		<svg
			aria-hidden="true"
			focusable="false"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.35"
			strokeLinecap="round"
			strokeLinejoin="round"
			className="correlation-icon"
		>
			${(ICON_PATHS[name] || ICON_PATHS.basket).map(
				(pathValue) => html`<path key=${pathValue} d=${pathValue} />`,
			)}
		</svg>
	`;
}

const CORRELATION_COLOR = scaleLinear()
	.domain([-1, -0.35, 0, 0.35, 1])
	.range(["#ff6680", "#5f2530", "#080909", "#06362d", "#089981"])
	.clamp(true);

const EMPTY_MATRIX = { tickers: [], values: [] };
const MATRIX_ICON_SIZE = 24;

function matrixCellSize(count) {
	if (count >= 42) return 14;
	if (count >= 30) return 16;
	if (count >= 22) return 18;
	if (count >= 14) return 22;
	return 42;
}

function matrixAxisSize(cellSize) {
	return Math.max(24, Math.min(36, cellSize + 8));
}

function getPairEntries(matrix) {
	const tickers = Array.isArray(matrix?.tickers) ? matrix.tickers : [];
	const values = Array.isArray(matrix?.values) ? matrix.values : [];
	const entries = [];
	for (let leftIndex = 0; leftIndex < tickers.length; leftIndex += 1) {
		for (
			let rightIndex = leftIndex + 1;
			rightIndex < tickers.length;
			rightIndex += 1
		) {
			const value = finiteNumber(values[leftIndex]?.[rightIndex]);
			if (value == null) continue;
			entries.push({
				left: tickers[leftIndex],
				right: tickers[rightIndex],
				value,
			});
		}
	}
	return entries;
}

function pairLabel(pair) {
	return pair ? `${pair.left}/${pair.right}` : "--";
}

function averagePairCorrelation(entries) {
	if (!entries.length) return null;
	return entries.reduce((sum, pair) => sum + pair.value, 0) / entries.length;
}

function buildInsightCards(normalMatrix, tailMatrix) {
	const normalPairs = getPairEntries(normalMatrix);
	const tailPairs = getPairEntries(tailMatrix);
	const strongestPair = [...normalPairs].sort((a, b) => b.value - a.value)[0];
	const diversifierPair = [...normalPairs].sort((a, b) => a.value - b.value)[0];
	const tailStressPair = [...tailPairs].sort((a, b) => b.value - a.value)[0];
	const averagePair = averagePairCorrelation(normalPairs);

	return [
		{
			key: "average",
			tone: "lime",
			icon: "basket",
			label: "Average pair",
			value: formatCorrelation(averagePair),
			detail: "Whole basket",
		},
		{
			key: "strongest",
			tone: "teal",
			icon: "cluster",
			label: "Tightest cluster",
			value: formatCorrelation(strongestPair?.value),
			detail: pairLabel(strongestPair),
		},
		{
			key: "diversifier",
			tone: "rose",
			icon: "hedge",
			label: "Best diversifier",
			value: formatCorrelation(diversifierPair?.value),
			detail: pairLabel(diversifierPair),
		},
		{
			key: "tail",
			tone: "amber",
			icon: "stress",
			label: "Tail stress",
			value: formatCorrelation(tailStressPair?.value),
			detail: pairLabel(tailStressPair),
		},
	];
}

function renderInsightCards(cards) {
	return html`
		<div className="correlation-insight-grid">
			${cards.map(
				(card) => html`
					<div
						key=${card.key}
						className=${`correlation-insight-card is-${card.tone}`}
					>
						<div className="correlation-insight-icon">
							${renderIcon(card.icon)}
						</div>
						<div className="correlation-insight-body">
							<span>${card.label}</span>
							<strong>${card.value}</strong>
							<small>${card.detail}</small>
						</div>
					</div>
				`,
			)}
		</div>
	`;
}

function renderMatrixTicker(ticker) {
	const symbol = getTradingViewTickerTagSymbol(ticker, { allowFunds: true });
	if (!symbol) {
		return html`
			<span className="correlation-matrix-ticker-fallback" title=${ticker}>
				${ticker}
			</span>
		`;
	}

	return html`
		<span className="correlation-matrix-ticker-icon" title=${ticker}>
			<tv-ticker-tag
				className="correlation-matrix-ticker-tag"
				symbol=${symbol}
				preserve-text
				hide-change
				hide-background
				theme="dark"
				transparent
				>${ticker}</tv-ticker-tag
			>
		</span>
	`;
}

function renderMatrixAxis(tickers, cellSize, axisSize, orientation) {
	const isColumn = orientation === "column";
	return tickers.map(
		(ticker, tickerIndex) => html`
			<foreignObject
				key=${`${orientation}-${ticker}`}
				className="correlation-matrix-axis-icon"
				x=${
					isColumn
						? axisSize + tickerIndex * cellSize
						: Math.max(0, axisSize - MATRIX_ICON_SIZE)
				}
				y=${
					isColumn
						? Math.max(0, axisSize - MATRIX_ICON_SIZE)
						: axisSize + tickerIndex * cellSize
				}
				width=${isColumn ? cellSize : MATRIX_ICON_SIZE}
				height=${isColumn ? MATRIX_ICON_SIZE : cellSize}
			>
				${renderMatrixTicker(ticker)}
			</foreignObject>
		`,
	);
}

function renderCorrelationScale() {
	return html`
		<div className="correlation-scale" aria-label="Correlation scale">
			<span>-1</span>
			<i>
				<b className="scale-negative-strong" aria-hidden="true"></b>
				<b className="scale-negative-soft" aria-hidden="true"></b>
				<b className="scale-neutral" aria-hidden="true"></b>
				<b className="scale-positive-soft" aria-hidden="true"></b>
				<b className="scale-positive-strong" aria-hidden="true"></b>
			</i>
			<span>+1</span>
		</div>
	`;
}

function renderMatrixCells(tickers, values, cellSize, showCellNumbers) {
	return tickers.flatMap((ticker, rowIndex) =>
		tickers.map((columnTicker, columnIndex) => {
			const value = values[rowIndex]?.[columnIndex];
			const numeric = finiteNumber(value);
			const displayValue = formatCorrelation(value);
			const label = `${ticker} / ${columnTicker}: ${displayValue}`;
			return html`
				<g
					key=${`${ticker}-${columnTicker}`}
					className="correlation-cell-group"
					transform=${`translate(${columnIndex * cellSize}, ${rowIndex * cellSize})`}
					aria-label=${label}
				>
					<rect
						className=${`correlation-matrix-cell ${
							rowIndex === columnIndex ? "is-diagonal" : ""
						}`}
						width=${cellSize}
						height=${cellSize}
						fill=${numeric == null ? "#090909" : CORRELATION_COLOR(numeric)}
					>
						<title>${label}</title>
					</rect>
					${
						showCellNumbers
							? html`
								<text
									className="correlation-matrix-cell-label"
									x=${cellSize / 2}
									y=${cellSize / 2}
									textAnchor="middle"
									dominantBaseline="central"
								>
									${displayValue}
								</text>
							`
							: null
					}
					<g
						className="correlation-cell-tooltip"
						transform=${`translate(${cellSize / 2}, -8)`}
					>
						<rect x="-54" y="-20" width="108" height="18" rx="2" />
						<text x="0" y="-7" textAnchor="middle">${label}</text>
					</g>
				</g>
			`;
		}),
	);
}

function renderMatrix(matrix, title, icon, caption) {
	const tickers = Array.isArray(matrix?.tickers) ? matrix.tickers : [];
	const values = Array.isArray(matrix?.values) ? matrix.values : [];
	const cellSize = matrixCellSize(tickers.length);
	const axisSize = matrixAxisSize(cellSize);
	const showCellNumbers = cellSize >= 18;
	const matrixWidth = axisSize + tickers.length * cellSize;
	const matrixHeight = axisSize + tickers.length * cellSize;

	if (tickers.length === 0) {
		return html`
			<section className="correlation-panel correlation-panel-empty">
				<div className="correlation-panel-title">
					${renderIcon(icon)}
					<span>${title}</span>
				</div>
				<div className="correlation-empty-copy">NO MATRIX</div>
			</section>
		`;
	}

	return html`
		<section className="correlation-panel correlation-matrix-panel">
			<div className="correlation-panel-heading">
				<div className="correlation-panel-title">
					${renderIcon(icon)}
					<span>${title}</span>
				</div>
				<div className="correlation-panel-meta">
					<div className="correlation-panel-caption">${caption}</div>
					${renderCorrelationScale()}
				</div>
			</div>
			<div className="correlation-matrix-scroll">
				<svg
					className="correlation-matrix"
					role="img"
					aria-label=${`${title} correlation matrix`}
					viewBox=${`0 0 ${matrixWidth} ${matrixHeight}`}
					style=${{
						width: `${matrixWidth}px`,
						height: `${matrixHeight}px`,
					}}
				>
					<rect
						className="correlation-matrix-corner"
						x="0"
						y="0"
						width=${axisSize}
						height=${axisSize}
					/>
					${renderMatrixAxis(tickers, cellSize, axisSize, "column")}
					${renderMatrixAxis(tickers, cellSize, axisSize, "row")}
					<g transform=${`translate(${axisSize}, ${axisSize})`}>
						${renderMatrixCells(tickers, values, cellSize, showCellNumbers)}
					</g>
				</svg>
			</div>
		</section>
	`;
}

function renderStats(statsPercent) {
	const rows = Array.isArray(statsPercent) ? statsPercent : [];
	return html`
		<section className="correlation-panel">
			<div className="correlation-panel-title">
				${renderIcon("returns")}
				<span>RETURN / VOL</span>
			</div>
			<div className="correlation-stat-table">
				${rows.map((row) => {
					const annualVol = parsePercent(row.annualizedStdDev);
					const bar = annualVol == null ? 0 : Math.min(100, annualVol * 1.5);
					return html`
						<div key=${row.ticker} className="correlation-stat-row">
							<span>${row.ticker}</span>
							<span>${row.annualizedReturn}</span>
							<span>
								${row.annualizedStdDev}
								<i style=${{ "--stat-bar": `${bar}%` }} />
							</span>
						</div>
					`;
				})}
			</div>
		</section>
	`;
}

function renderBetas(marketBetas) {
	const entries = Object.entries(marketBetas || {});
	if (entries.length === 0) return null;

	return html`
		<section className="correlation-panel">
			<div className="correlation-panel-title">
				${renderIcon("beta")}
				<span>SPY BETAS</span>
			</div>
			<div className="correlation-beta-grid">
				${entries.map(
					([ticker, beta]) => html`
						<div key=${ticker} className="correlation-beta-item">
							<span>${ticker}</span>
							<strong>${formatCorrelation(beta)}</strong>
						</div>
					`,
				)}
			</div>
		</section>
	`;
}

export function CorrelationView({
	data,
	mode,
	setMode,
	isLoading,
	lastError,
	tickers,
}) {
	const hasEnoughTickers = tickers.length >= 2;
	const payload = data;
	const tailRounded = payload?.tailMatrixPsd
		? {
				tickers: payload.tailMatrixPsd.tickers,
				values: payload.tailMatrixPsd.values.map((row) =>
					row.map((value) => {
						const numeric = finiteNumber(value);
						return numeric == null ? null : Math.round(numeric * 100) / 100;
					}),
				),
			}
		: EMPTY_MATRIX;
	const insightCards = buildInsightCards(
		payload?.normalMatrixRounded,
		tailRounded,
	);

	return html`
		<div className="correlation-view">
			<div className="correlation-toolbar">
				<div>
					<div className="correlation-kicker">PORTFOLIO CORRELATION</div>
					<div className="correlation-title-row">
						<span>${tickers.length} TICKERS</span>
						<span>${mode === "raw" ? "RAW RETURNS" : "SPY RESIDUALS"}</span>
						${isLoading ? html`<span className="is-live">REFRESHING</span>` : null}
					</div>
				</div>
				<div className="correlation-actions">
					<div className="correlation-mode-toggle" aria-label="Correlation mode">
						${MODES.map(
							(item) => html`
								<button
									key=${item.value}
									type="button"
									className=${`correlation-mode-btn ${
										mode === item.value ? "active" : ""
									}`}
									aria-pressed=${mode === item.value}
									onClick=${() => setMode(item.value)}
								>
									${item.label}
								</button>
							`,
						)}
					</div>
				</div>
			</div>

			${
				!hasEnoughTickers
					? html`<div className="correlation-state">ADD AT LEAST TWO HOLDINGS</div>`
					: lastError
						? html`<div className="correlation-state">CORRELATION FAILED</div>`
						: isLoading && !payload
							? html`
								<div className="correlation-skeleton">
									<div />
									<div />
									<div />
								</div>
							`
							: html`
								<div className="correlation-layout">
									<div className="correlation-primary">
										${renderInsightCards(insightCards)}
										${renderMatrix(
											payload?.normalMatrixRounded,
											"NORMAL",
											"cluster",
											mode === "raw"
												? "Full-return co-movement"
												: "Residual co-movement after SPY beta",
										)}
										${renderMatrix(
											tailRounded,
											"DOWN MARKET",
											"stress",
											"Filtered to negative SPY sessions",
										)}
									</div>
									<aside className="correlation-rail">
										${renderStats(payload?.statsPercent)}
										${renderBetas(payload?.diagnostics?.marketBetas)}
									</aside>
								</div>
							`
			}
		</div>
	`;
}
