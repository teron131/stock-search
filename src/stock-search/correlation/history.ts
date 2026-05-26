import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { appConfig } from "../api/config.js";
import { yahooSymbolForTicker } from "../data-sources/provider-symbols.js";
import { fetchJson, toFiniteNumber } from "../data-sources/shared.js";
import { normalizeTicker, uniqueTickers } from "../utils.js";
import {
	DEFAULT_CORRELATION_TICKERS,
	HISTORY_INTERVAL,
	HISTORY_RANGE,
	MAX_FETCH_WORKERS,
} from "./constants.js";
import {
	dateFromKey,
	dateKey,
	emptyTimeSeriesFrame,
	frameFromRows,
} from "./time-series.js";
import type {
	CloseHistory,
	ClosePoint,
	TimeSeriesFrame,
	TimeSeriesRow,
	YahooChartResponse,
} from "./types.js";

const require = createRequire(import.meta.url);

function loadPositionsFromJson(): Array<Record<string, unknown>> {
	const portfolioPath = path.join(appConfig.repoRoot, "data", "portfolio.json");
	if (!existsSync(portfolioPath)) {
		return [];
	}
	try {
		const payload = JSON.parse(readFileSync(portfolioPath, "utf8")) as unknown;
		return Array.isArray(payload)
			? payload.filter(
					(row): row is Record<string, unknown> =>
						typeof row === "object" && row !== null && !Array.isArray(row),
				)
			: [];
	} catch {
		return [];
	}
}

function loadPositionsFromSqlite(): Array<Record<string, unknown>> {
	if (!existsSync(appConfig.dataSqlitePath)) {
		return [];
	}

	const { DatabaseSync } =
		require("node:sqlite") as typeof import("node:sqlite");
	let database: import("node:sqlite").DatabaseSync | null = null;
	try {
		database = new DatabaseSync(appConfig.dataSqlitePath, { readOnly: true });
		const rows = database
			.prepare(
				`
				SELECT payload_json
				FROM positions
				ORDER BY sort_index ASC, ticker ASC
				`,
			)
			.all() as Array<{ payload_json?: string }>;
		return rows
			.map((row) => {
				try {
					const payload = JSON.parse(row.payload_json ?? "") as unknown;
					return typeof payload === "object" &&
						payload !== null &&
						!Array.isArray(payload)
						? (payload as Record<string, unknown>)
						: null;
				} catch {
					return null;
				}
			})
			.filter((row): row is Record<string, unknown> => row != null);
	} catch {
		return [];
	} finally {
		database?.close();
	}
}

export function loadCorrelationPositions(): Array<Record<string, unknown>> {
	const jsonPositions = loadPositionsFromJson();
	return jsonPositions.length > 0 ? jsonPositions : loadPositionsFromSqlite();
}

export function resolveCorrelationTickers(
	tickers = DEFAULT_CORRELATION_TICKERS,
): string[] {
	const configured = uniqueTickers(tickers);
	if (configured.length > 0) {
		return configured;
	}
	return uniqueTickers(
		loadCorrelationPositions()
			.map((row) => normalizeTicker(String(row.ticker ?? "")))
			.filter(Boolean),
	);
}

export async function fetchYahooCloseHistory(
	ticker: string,
): Promise<CloseHistory> {
	const tickerSymbol = normalizeTicker(ticker);
	const yahooTicker = yahooSymbolForTicker(tickerSymbol);
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
		yahooTicker,
	)}?range=${HISTORY_RANGE}&interval=${HISTORY_INTERVAL}&includePrePost=false&events=history&includeAdjustedClose=true`;
	const payload = await fetchJson<YahooChartResponse>(url);
	const result = payload?.chart?.result?.[0];
	const timestamps = result?.timestamp ?? [];
	const closeValues =
		result?.indicators?.adjclose?.[0]?.adjclose ??
		result?.indicators?.quote?.[0]?.close ??
		[];
	const points: ClosePoint[] = [];
	for (const [index, timestamp] of timestamps.entries()) {
		const close = toFiniteNumber(closeValues[index]);
		if (close == null || !Number.isFinite(timestamp)) {
			continue;
		}
		points.push({
			date: new Date(timestamp * 1000),
			close,
		});
	}
	return {
		ticker: tickerSymbol,
		name: result?.meta?.shortName ?? result?.meta?.longName ?? tickerSymbol,
		points,
	};
}

export async function buildCloseRowsAndNames(
	tickers: string[],
	historyFetcher: (ticker: string) => Promise<CloseHistory>,
): Promise<{ frame: TimeSeriesFrame; names: Record<string, string> }> {
	if (tickers.length === 0) {
		return { frame: emptyTimeSeriesFrame(), names: {} };
	}

	const histories: CloseHistory[] = [];
	for (let index = 0; index < tickers.length; index += MAX_FETCH_WORKERS) {
		histories.push(
			...(await Promise.all(
				tickers.slice(index, index + MAX_FETCH_WORKERS).map(historyFetcher),
			)),
		);
	}

	const rowsByDate = new Map<string, TimeSeriesRow>();
	const names: Record<string, string> = {};
	for (const history of histories) {
		if (history.points.length === 0) {
			continue;
		}
		names[history.ticker] = history.name;
		for (const point of history.points) {
			const key = dateKey(point.date);
			const row = rowsByDate.get(key) ?? {
				date: dateFromKey(key),
				values: new Map<string, number>(),
			};
			row.values.set(history.ticker, point.close);
			rowsByDate.set(key, row);
		}
	}

	return {
		frame: frameFromRows(
			[...rowsByDate.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([, row]) => row),
		),
		names,
	};
}
