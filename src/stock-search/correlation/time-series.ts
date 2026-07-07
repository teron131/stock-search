/** Owns Polars-backed price and return time-series transforms for correlation. */

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

function valueColumns(frame: TimeSeriesFrame): string[] {
	return frame.columns.filter((column) => column !== DATE_COLUMN);
}

function presentTickerColumns(
	frame: TimeSeriesFrame,
	tickers: string[],
): string[] {
	const columns = new Set(frame.columns);
	return tickers.filter((ticker) => columns.has(ticker));
}

function anyFiniteValue(columns: string[]) {
	return pl.anyHorizontal(columns.map((column) => pl.col(column).isFinite()));
}

export function hasAnyFiniteTickerValue(
	frame: TimeSeriesFrame,
	tickers: string[] = valueColumns(frame),
): boolean {
	const columns = presentTickerColumns(frame, tickers);
	return columns.length > 0 && frame.filter(anyFiniteValue(columns)).height > 0;
}

export function selectTickerRows(
	frame: TimeSeriesFrame,
	tickers: string[],
): TimeSeriesFrame {
	return frame.select(DATE_COLUMN, ...presentTickerColumns(frame, tickers));
}

export function pctChangeRows(frame: TimeSeriesFrame): TimeSeriesFrame {
	const columns = valueColumns(frame);
	if (columns.length === 0) {
		return emptyTimeSeriesFrame();
	}
	return frame
		.sort(DATE_COLUMN)
		.select(
			DATE_COLUMN,
			...columns.map((column) =>
				pl.col(column).div(pl.col(column).shift(1)).sub(1).alias(column),
			),
		)
		.filter(anyFiniteValue(columns));
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
	const present = new Set(frame.columns);
	for (let leftIndex = 0; leftIndex < tickers.length; leftIndex += 1) {
		for (let rightIndex = 0; rightIndex < tickers.length; rightIndex += 1) {
			const left = tickers[leftIndex];
			const right = tickers[rightIndex];
			if (!present.has(left) || !present.has(right)) {
				continue;
			}
			result[leftIndex][rightIndex] = frame.filter(
				pl.col(left).isFinite().and(pl.col(right).isFinite()),
			).height;
		}
	}
	return result;
}

export function correlationValues(
	frame: TimeSeriesFrame,
	tickers: string[],
): number[][] {
	const result = Array.from({ length: tickers.length }, () =>
		Array(tickers.length).fill(Number.NaN),
	);
	const present = new Set(frame.columns);
	for (let leftIndex = 0; leftIndex < tickers.length; leftIndex += 1) {
		for (
			let rightIndex = leftIndex;
			rightIndex < tickers.length;
			rightIndex += 1
		) {
			const left = tickers[leftIndex];
			const right = tickers[rightIndex];
			if (!present.has(left) || !present.has(right)) {
				continue;
			}
			const valid = frame.filter(
				pl.col(left).isFinite().and(pl.col(right).isFinite()),
			);
			if (valid.height < 2) {
				continue;
			}
			const correlation = valid
				.select(pl.pearsonCorr(left, right).alias("correlation"))
				.toRecords()[0]?.correlation;
			if (!isFiniteNumber(correlation)) {
				continue;
			}
			result[leftIndex][rightIndex] = correlation;
			result[rightIndex][leftIndex] = correlation;
		}
	}
	return result;
}
