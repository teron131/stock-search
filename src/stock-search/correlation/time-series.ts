import pl from "nodejs-polars";

import { DATE_COLUMN } from "./constants.js";
import type { HorizonConfig, TimeSeriesFrame, TimeSeriesRow } from "./types.js";

export function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function dateKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}

export function dateFromKey(key: string): Date {
	return new Date(`${key}T00:00:00.000Z`);
}

export function emptyTimeSeriesFrame(): TimeSeriesFrame {
	return pl.DataFrame({ [DATE_COLUMN]: [] });
}

export function frameFromRows(rows: TimeSeriesRow[]): TimeSeriesFrame {
	if (rows.length === 0) {
		return emptyTimeSeriesFrame();
	}
	return pl
		.DataFrame(
			rows.map((row) => ({
				[DATE_COLUMN]: row.date,
				...Object.fromEntries(row.values),
			})),
		)
		.sort(DATE_COLUMN);
}

export function rowsFromFrame(frame: TimeSeriesFrame): TimeSeriesRow[] {
	return frame.toRecords().flatMap((record) => {
		const rawDate = record[DATE_COLUMN] as unknown;
		const date = rawDate instanceof Date ? rawDate : new Date(String(rawDate));
		if (Number.isNaN(date.getTime())) {
			return [];
		}
		const values = new Map<string, number>();
		for (const [key, value] of Object.entries(record)) {
			if (key === DATE_COLUMN || !isFiniteNumber(value)) {
				continue;
			}
			values.set(key, value);
		}
		return [{ date, values }];
	});
}

export function dedupePreserveOrder(values: string[]): string[] {
	return [...new Set(values)];
}

export function selectTickerRows(
	frame: TimeSeriesFrame,
	tickers: string[],
): TimeSeriesFrame {
	return frameFromRows(
		rowsFromFrame(frame).map((row) => ({
			date: row.date,
			values: new Map(
				tickers.flatMap((ticker) => {
					const value = row.values.get(ticker);
					return isFiniteNumber(value) ? [[ticker, value] as const] : [];
				}),
			),
		})),
	);
}

export function pctChangeRows(frame: TimeSeriesFrame): TimeSeriesFrame {
	const previous = new Map<string, number>();
	const tickerColumns = frame.columns.filter(
		(column) => column !== DATE_COLUMN,
	);
	const returns: TimeSeriesRow[] = [];
	for (const row of rowsFromFrame(frame.sort(DATE_COLUMN))) {
		const values = new Map<string, number>();
		for (const ticker of tickerColumns) {
			const current = row.values.get(ticker);
			const prior = previous.get(ticker);
			if (isFiniteNumber(prior) && prior !== 0 && isFiniteNumber(current)) {
				values.set(ticker, current / prior - 1);
			}
			if (isFiniteNumber(current)) {
				previous.set(ticker, current);
			} else {
				previous.delete(ticker);
			}
		}
		if (values.size > 0) {
			returns.push({ date: row.date, values });
		}
	}
	return frameFromRows(returns);
}

export function weekEndingFriday(date: Date): Date {
	const day = date.getUTCDay();
	const daysToFriday = (5 - day + 7) % 7;
	const bucket = new Date(date);
	bucket.setUTCDate(bucket.getUTCDate() + daysToFriday);
	return dateFromKey(dateKey(bucket));
}

export function monthEnd(date: Date): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

export function resampleLastByBucket(
	frame: TimeSeriesFrame,
	bucketForDate: (date: Date) => Date,
): TimeSeriesFrame {
	const rowsByBucket = new Map<string, TimeSeriesRow>();
	for (const row of rowsFromFrame(frame.sort(DATE_COLUMN))) {
		const bucket = bucketForDate(row.date);
		rowsByBucket.set(dateKey(bucket), {
			date: bucket,
			values: new Map(row.values),
		});
	}
	return frameFromRows(
		[...rowsByBucket.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, row]) => row),
	);
}

export function buildReturnFrames(
	frame: TimeSeriesFrame,
): Record<HorizonConfig["name"], TimeSeriesFrame> {
	return {
		daily: pctChangeRows(frame),
		weekly: pctChangeRows(resampleLastByBucket(frame, weekEndingFriday)),
		monthly: pctChangeRows(resampleLastByBucket(frame, monthEnd)),
	};
}

export function subtractYears(date: Date, years: number): Date {
	const day = date.getUTCDate();
	const month = date.getUTCMonth();
	const year = date.getUTCFullYear() - years;
	const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}

export function sliceRowsToLookback(
	frame: TimeSeriesFrame,
	years: number,
): TimeSeriesFrame {
	const rows = rowsFromFrame(frame);
	if (rows.length === 0) {
		return frame;
	}
	const end = rows.at(-1)?.date;
	if (!end) {
		return frame;
	}
	const start = subtractYears(end, years).getTime();
	return frameFromRows(rows.filter((row) => row.date.getTime() >= start));
}

export function valuesForTicker(
	frame: TimeSeriesFrame,
	ticker: string,
): number[] {
	return rowsFromFrame(frame).map(
		(row) => row.values.get(ticker) ?? Number.NaN,
	);
}

export function pairCounts(
	frame: TimeSeriesFrame,
	tickers: string[],
): number[][] {
	const result = Array.from({ length: tickers.length }, () =>
		Array(tickers.length).fill(0),
	);
	const rows = rowsFromFrame(frame);
	for (let leftIndex = 0; leftIndex < tickers.length; leftIndex += 1) {
		for (let rightIndex = 0; rightIndex < tickers.length; rightIndex += 1) {
			let count = 0;
			for (const row of rows) {
				if (
					isFiniteNumber(row.values.get(tickers[leftIndex])) &&
					isFiniteNumber(row.values.get(tickers[rightIndex]))
				) {
					count += 1;
				}
			}
			result[leftIndex][rightIndex] = count;
		}
	}
	return result;
}

export function correlationValues(
	frame: TimeSeriesFrame,
	tickers: string[],
): number[][] {
	const rows = rowsFromFrame(frame);
	const result = Array.from({ length: tickers.length }, () =>
		Array(tickers.length).fill(Number.NaN),
	);
	for (let leftIndex = 0; leftIndex < tickers.length; leftIndex += 1) {
		for (
			let rightIndex = leftIndex;
			rightIndex < tickers.length;
			rightIndex += 1
		) {
			const pairs = rows
				.map((row) => [
					row.values.get(tickers[leftIndex]),
					row.values.get(tickers[rightIndex]),
				])
				.filter(
					(pair): pair is [number, number] =>
						isFiniteNumber(pair[0]) && isFiniteNumber(pair[1]),
				);
			if (pairs.length < 2) {
				continue;
			}
			const leftMean =
				pairs.reduce((sum, [left]) => sum + left, 0) / pairs.length;
			const rightMean =
				pairs.reduce((sum, [, right]) => sum + right, 0) / pairs.length;
			let numerator = 0;
			let leftVariance = 0;
			let rightVariance = 0;
			for (const [left, right] of pairs) {
				const leftCentered = left - leftMean;
				const rightCentered = right - rightMean;
				numerator += leftCentered * rightCentered;
				leftVariance += leftCentered ** 2;
				rightVariance += rightCentered ** 2;
			}
			const denominator = Math.sqrt(leftVariance * rightVariance);
			if (denominator <= 0) {
				continue;
			}
			const correlation = numerator / denominator;
			result[leftIndex][rightIndex] = correlation;
			result[rightIndex][leftIndex] = correlation;
		}
	}
	return result;
}
