/** Public API and CLI entrypoint for the portfolio correlation report. */

import {
	DEFAULT_EFFECTIVE_SLEEVE_CAP,
	MARKET_PROXY_TICKER,
} from "./correlation/constants.js";

export {
	DEFAULT_CORRELATION_TICKERS,
	HORIZONS,
	LOOKBACKS,
} from "./correlation/constants.js";

import {
	buildCloseRowsAndNames,
	fetchYahooCloseHistory,
	resolveCorrelationTickers,
} from "./correlation/history.js";

export {
	loadCorrelationPositions,
	resolveCorrelationTickers,
} from "./correlation/history.js";

import {
	buildBlendedMatrix,
	emptyMatrix,
	estimateMarketBetas,
	roundMatrix,
} from "./correlation/matrix.js";

export { buildBlendedMatrix } from "./correlation/matrix.js";

import {
	buildSleeveWeightRecommendations,
	buildTickerStats,
	formatStatsPercent,
} from "./correlation/report.js";

export { buildSleeveWeightRecommendations } from "./correlation/report.js";

import {
	buildReturnFrames,
	isFiniteNumber,
	rowsFromFrame,
	selectTickerRows,
} from "./correlation/time-series.js";

export type {
	BlendWeightMode,
	CloseHistory,
	ClosePoint,
	CorrelationDiagnostics,
	CorrelationMatrix,
	CorrelationMode,
	CorrelationReport,
	CorrelationReportOptions,
	HorizonConfig,
	LookbackConfig,
	SleeveWeightRecommendation,
	TickerCorrelationStats,
	TimeSeriesFrame,
} from "./correlation/types.js";

import type {
	CorrelationReport,
	CorrelationReportOptions,
} from "./correlation/types.js";
import { normalizeTicker } from "./utils.js";

/** Build the full correlation report from portfolio/default tickers and Yahoo close history. */
export async function runCorrelationReport(
	options: CorrelationReportOptions = {},
): Promise<CorrelationReport> {
	const portfolioTickers = resolveCorrelationTickers(options.tickers);
	if (portfolioTickers.length === 0) {
		throw new Error(
			"No tickers found. Pass tickers or add positions to the local portfolio store.",
		);
	}

	const correlationMode = options.correlationMode ?? "raw";
	const blendWeightMode = options.blendWeightMode ?? "hybrid";
	const marketTicker = normalizeTicker(
		options.marketProxyTicker ?? MARKET_PROXY_TICKER,
	);
	const fetchTickers = marketTicker
		? [...new Set([...portfolioTickers, marketTicker])]
		: portfolioTickers;
	const { frame, names } = await buildCloseRowsAndNames(
		fetchTickers,
		options.historyFetcher ?? fetchYahooCloseHistory,
	);
	if (frame.height === 0) {
		throw new Error(
			"No valid close price history available for requested tickers.",
		);
	}

	const frameRows = rowsFromFrame(frame);
	const activeTickers = portfolioTickers.filter((ticker) =>
		frameRows.some((row) => isFiniteNumber(row.values.get(ticker))),
	);
	if (activeTickers.length === 0) {
		throw new Error(
			"No valid close price history available for requested tickers.",
		);
	}
	const hasMarketHistory = frameRows.some((row) =>
		isFiniteNumber(row.values.get(marketTicker)),
	);
	const correlationTickers =
		marketTicker && hasMarketHistory
			? [...activeTickers, marketTicker]
			: activeTickers;
	const correlationFrame = selectTickerRows(frame, correlationTickers);
	const normalResult = buildBlendedMatrix(correlationFrame, activeTickers, {
		blendWeightMode,
		correlationMode,
		marketProxyTicker:
			correlationMode === "market_neutral" ? marketTicker : null,
	});
	let tailRawMatrix = emptyMatrix();
	let tailPsdMatrix = emptyMatrix();
	if (marketTicker && correlationTickers.includes(marketTicker)) {
		const tailResult = buildBlendedMatrix(correlationFrame, activeTickers, {
			blendWeightMode,
			correlationMode,
			marketProxyTicker:
				correlationMode === "market_neutral" ? marketTicker : null,
			tailMarketTicker: marketTicker,
		});
		tailRawMatrix = tailResult.rawMatrix;
		tailPsdMatrix = tailResult.psdMatrix;
		normalResult.diagnostics.tail = tailResult.diagnostics;
	}
	if (correlationMode === "market_neutral" && marketTicker) {
		normalResult.diagnostics.marketBetas = estimateMarketBetas(
			buildReturnFrames(correlationFrame).daily,
			marketTicker,
		);
	}
	const stats = buildTickerStats(
		selectTickerRows(frame, activeTickers),
		activeTickers,
		names,
	);
	return {
		tickers: activeTickers,
		normalMatrixRaw: normalResult.rawMatrix,
		normalMatrixPsd: normalResult.psdMatrix,
		normalMatrixRounded: roundMatrix(normalResult.psdMatrix, 2),
		tailMatrixPsd: tailPsdMatrix,
		tailMatrixRaw: tailRawMatrix,
		sleeveWeightRecommendations: buildSleeveWeightRecommendations({
			tickers: activeTickers,
			normalCorrelationMatrix: normalResult.psdMatrix,
			tailRawCorrelationMatrix:
				tailRawMatrix.tickers.length > 0 ? tailRawMatrix : undefined,
			effectiveSleeveCap:
				options.effectiveSleeveCap ?? DEFAULT_EFFECTIVE_SLEEVE_CAP,
			tickerMarkers: options.tickerMarkers,
		}),
		stats,
		statsPercent: formatStatsPercent(stats),
		diagnostics: normalResult.diagnostics,
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const tickers = process.argv.slice(2);
	runCorrelationReport({ tickers })
		.then((report) => {
			console.log(JSON.stringify(report, null, 2));
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
}
