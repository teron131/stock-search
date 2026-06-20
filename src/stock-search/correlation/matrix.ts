import pl from "nodejs-polars";

import {
	ATANH_EPSILON,
	EIGEN_TOLERANCE,
	HORIZONS,
	LOOKBACKS,
	MIN_RESIDUAL_OBSERVATIONS,
	PSD_EIGENVALUE_FLOOR,
	PSD_SHRINKAGE,
} from "./constants.js";
import {
	buildReturnFrames,
	correlationValues,
	dateFromKey,
	dateKey,
	dedupePreserveOrder,
	emptyTimeSeriesFrame,
	frameFromRows,
	hasAnyFiniteTickerValue,
	isFiniteNumber,
	pairCounts,
	rowsFromFrame,
	selectTickerRows,
	sliceRowsToLookback,
} from "./time-series.js";
import type {
	BlendWeightMode,
	CorrelationDiagnostics,
	CorrelationInput,
	CorrelationMatrix,
	CorrelationMode,
	TimeSeriesFrame,
	TimeSeriesRow,
} from "./types.js";

function matrixFromValues(
	tickers: string[],
	values: number[][],
): CorrelationMatrix {
	return {
		tickers,
		values: values.map((row) =>
			row.map((value) => (Number.isFinite(value) ? value : null)),
		),
	};
}

function valuesFromMatrix(matrix: CorrelationMatrix): number[][] {
	return matrix.values.map((row) =>
		row.map((value) => (value == null ? Number.NaN : value)),
	);
}

export function emptyMatrix(): CorrelationMatrix {
	return { tickers: [], values: [] };
}

export function roundMatrix(
	matrix: CorrelationMatrix,
	decimals: number,
): CorrelationMatrix {
	const scale = 10 ** decimals;
	return {
		tickers: matrix.tickers,
		values: matrix.values.map((row) =>
			row.map((value) =>
				value == null ? null : Math.round(value * scale) / scale,
			),
		),
	};
}

function zeros(rows: number, columns: number): number[][] {
	return Array.from({ length: rows }, () => Array(columns).fill(0));
}

function identity(size: number): number[][] {
	const result = zeros(size, size);
	for (let index = 0; index < size; index += 1) {
		result[index][index] = 1;
	}
	return result;
}

function cloneMatrix(values: number[][]): number[][] {
	return values.map((row) => [...row]);
}

function transpose(values: number[][]): number[][] {
	if (values.length === 0) {
		return [];
	}
	return values[0].map((_, columnIndex) =>
		values.map((row) => row[columnIndex]),
	);
}

function multiplyMatrices(left: number[][], right: number[][]): number[][] {
	const rowCount = left.length;
	const columnCount = right[0]?.length ?? 0;
	const sharedCount = right.length;
	const result = zeros(rowCount, columnCount);
	for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
		for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
			let sum = 0;
			for (let sharedIndex = 0; sharedIndex < sharedCount; sharedIndex += 1) {
				sum += left[rowIndex][sharedIndex] * right[sharedIndex][columnIndex];
			}
			result[rowIndex][columnIndex] = sum;
		}
	}
	return result;
}

function diagonal(values: number[]): number[][] {
	const result = zeros(values.length, values.length);
	for (let index = 0; index < values.length; index += 1) {
		result[index][index] = values[index];
	}
	return result;
}

function minValue(values: number[]): number {
	return values.length > 0 ? Math.min(...values) : 0;
}

function jacobiEigenSymmetric(input: number[][]): {
	eigenvalues: number[];
	eigenvectors: number[][];
} {
	const size = input.length;
	const values = cloneMatrix(input);
	const eigenvectors = identity(size);
	const maxIterations = Math.max(1, size * size * 100);

	for (let iteration = 0; iteration < maxIterations; iteration += 1) {
		let pivotRow = 0;
		let pivotColumn = 1;
		let maxOffDiagonal = 0;
		for (let rowIndex = 0; rowIndex < size; rowIndex += 1) {
			for (
				let columnIndex = rowIndex + 1;
				columnIndex < size;
				columnIndex += 1
			) {
				const magnitude = Math.abs(values[rowIndex][columnIndex]);
				if (magnitude > maxOffDiagonal) {
					maxOffDiagonal = magnitude;
					pivotRow = rowIndex;
					pivotColumn = columnIndex;
				}
			}
		}

		if (maxOffDiagonal < EIGEN_TOLERANCE || size < 2) {
			break;
		}

		const app = values[pivotRow][pivotRow];
		const aqq = values[pivotColumn][pivotColumn];
		const apq = values[pivotRow][pivotColumn];
		const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
		const cosine = Math.cos(angle);
		const sine = Math.sin(angle);

		for (let index = 0; index < size; index += 1) {
			if (index === pivotRow || index === pivotColumn) {
				continue;
			}
			const aip = values[index][pivotRow];
			const aiq = values[index][pivotColumn];
			values[index][pivotRow] = cosine * aip - sine * aiq;
			values[pivotRow][index] = values[index][pivotRow];
			values[index][pivotColumn] = sine * aip + cosine * aiq;
			values[pivotColumn][index] = values[index][pivotColumn];
		}

		values[pivotRow][pivotRow] =
			cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
		values[pivotColumn][pivotColumn] =
			sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
		values[pivotRow][pivotColumn] = 0;
		values[pivotColumn][pivotRow] = 0;

		for (let index = 0; index < size; index += 1) {
			const vip = eigenvectors[index][pivotRow];
			const viq = eigenvectors[index][pivotColumn];
			eigenvectors[index][pivotRow] = cosine * vip - sine * viq;
			eigenvectors[index][pivotColumn] = sine * vip + cosine * viq;
		}
	}

	return {
		eigenvalues: values.map((row, index) => row[index]),
		eigenvectors,
	};
}

function calculateBlendedPairCorrelation(
	leftIndex: number,
	rightIndex: number,
	inputs: CorrelationInput[],
	blendWeightMode: BlendWeightMode,
): number | null {
	let weightedSum = 0;
	let weightTotal = 0;
	for (const input of inputs) {
		const correlation = input.correlationValues[leftIndex][rightIndex];
		const pairCount = input.pairCountValues[leftIndex][rightIndex];
		if (!Number.isFinite(correlation) || !Number.isFinite(pairCount)) {
			continue;
		}
		if (pairCount < input.minObservations) {
			continue;
		}
		const clipped = Math.max(
			-1 + ATANH_EPSILON,
			Math.min(1 - ATANH_EPSILON, correlation),
		);
		const zValue = Math.atanh(clipped);
		const reliabilityWeight = Math.sqrt(Math.max(pairCount - 3, 0));
		const finalWeight =
			blendWeightMode === "reliability"
				? reliabilityWeight
				: blendWeightMode === "intent"
					? input.intentWeight
					: reliabilityWeight * input.intentWeight;
		if (finalWeight <= 0) {
			continue;
		}
		weightedSum += finalWeight * zValue;
		weightTotal += finalWeight;
	}
	return weightTotal > 0 ? Math.tanh(weightedSum / weightTotal) : null;
}

function fisherBlendedCorrelation(
	tickers: string[],
	inputs: CorrelationInput[],
	blendWeightMode: BlendWeightMode,
): CorrelationMatrix {
	const values = Array.from({ length: tickers.length }, () =>
		Array(tickers.length).fill(Number.NaN),
	);
	for (let index = 0; index < tickers.length; index += 1) {
		values[index][index] = 1;
	}
	for (let leftIndex = 0; leftIndex < tickers.length; leftIndex += 1) {
		for (
			let rightIndex = leftIndex + 1;
			rightIndex < tickers.length;
			rightIndex += 1
		) {
			const correlation = calculateBlendedPairCorrelation(
				leftIndex,
				rightIndex,
				inputs,
				blendWeightMode,
			);
			if (correlation == null) {
				continue;
			}
			values[leftIndex][rightIndex] = correlation;
			values[rightIndex][leftIndex] = correlation;
		}
	}
	return matrixFromValues(tickers, values);
}

function alignedMarketRows(
	frame: TimeSeriesFrame,
	marketTicker: string,
): Array<{
	ticker: string;
	dates: Date[];
	tickerReturns: number[];
	marketReturns: number[];
}> {
	const rows = rowsFromFrame(frame);
	const tickers = dedupePreserveOrder(
		rows.flatMap((row) => [...row.values.keys()]),
	).filter((ticker) => ticker !== marketTicker);
	const result = [];
	for (const ticker of tickers) {
		const dates: Date[] = [];
		const tickerReturns: number[] = [];
		const marketReturns: number[] = [];
		for (const row of rows) {
			const tickerReturn = row.values.get(ticker);
			const marketReturn = row.values.get(marketTicker);
			if (!isFiniteNumber(tickerReturn) || !isFiniteNumber(marketReturn)) {
				continue;
			}
			dates.push(row.date);
			tickerReturns.push(tickerReturn);
			marketReturns.push(marketReturn);
		}
		if (dates.length >= MIN_RESIDUAL_OBSERVATIONS) {
			result.push({ ticker, dates, tickerReturns, marketReturns });
		}
	}
	return result;
}

function mean(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function residualizeReturns(
	frame: TimeSeriesFrame,
	marketTicker: string,
): TimeSeriesFrame {
	const rows = rowsFromFrame(frame);
	if (rows.length === 0) {
		return emptyTimeSeriesFrame();
	}
	const rowsByDate = new Map<string, TimeSeriesRow>();
	for (const aligned of alignedMarketRows(frame, marketTicker)) {
		const marketMean = mean(aligned.marketReturns);
		const tickerMean = mean(aligned.tickerReturns);
		let marketSumSquares = 0;
		let covariance = 0;
		for (let index = 0; index < aligned.marketReturns.length; index += 1) {
			const centeredMarket = aligned.marketReturns[index] - marketMean;
			marketSumSquares += centeredMarket ** 2;
			covariance +=
				(aligned.tickerReturns[index] - tickerMean) * centeredMarket;
		}
		if (marketSumSquares <= 0) {
			continue;
		}
		const beta = covariance / marketSumSquares;
		const alpha = tickerMean - beta * marketMean;
		for (let index = 0; index < aligned.dates.length; index += 1) {
			const residual =
				aligned.tickerReturns[index] -
				(alpha + beta * aligned.marketReturns[index]);
			const key = dateKey(aligned.dates[index]);
			const row = rowsByDate.get(key) ?? {
				date: dateFromKey(key),
				values: new Map<string, number>(),
			};
			row.values.set(aligned.ticker, residual);
			rowsByDate.set(key, row);
		}
	}
	return frameFromRows(
		[...rowsByDate.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, row]) => row),
	);
}

export function estimateMarketBetas(
	frame: TimeSeriesFrame,
	marketTicker: string,
): Record<string, number> {
	const betas: Record<string, number> = {};
	for (const aligned of alignedMarketRows(frame, marketTicker)) {
		const marketMean = mean(aligned.marketReturns);
		const tickerMean = mean(aligned.tickerReturns);
		let marketSumSquares = 0;
		let covariance = 0;
		for (let index = 0; index < aligned.marketReturns.length; index += 1) {
			const centeredMarket = aligned.marketReturns[index] - marketMean;
			marketSumSquares += centeredMarket ** 2;
			covariance +=
				(aligned.tickerReturns[index] - tickerMean) * centeredMarket;
		}
		if (marketSumSquares > 0) {
			betas[aligned.ticker] = covariance / marketSumSquares;
		}
	}
	return betas;
}

export function buildBlendedMatrix(
	frame: TimeSeriesFrame,
	tickers: string[],
	{
		blendWeightMode,
		correlationMode,
		marketProxyTicker,
		tailMarketTicker,
	}: {
		blendWeightMode: BlendWeightMode;
		correlationMode: CorrelationMode;
		marketProxyTicker?: string | null;
		tailMarketTicker?: string | null;
	},
): {
	rawMatrix: CorrelationMatrix;
	psdMatrix: CorrelationMatrix;
	diagnostics: CorrelationDiagnostics;
} {
	const returnFrames = buildReturnFrames(frame);
	const inputs: CorrelationInput[] = [];
	const components: CorrelationDiagnostics["components"] = {};
	for (const horizon of HORIZONS) {
		let horizonFrame = returnFrames[horizon.name];
		if (tailMarketTicker) {
			horizonFrame = horizonFrame.columns.includes(tailMarketTicker)
				? horizonFrame.filter(pl.col(tailMarketTicker).lt(0))
				: emptyTimeSeriesFrame();
		}
		if (correlationMode === "market_neutral" && marketProxyTicker) {
			horizonFrame = residualizeReturns(horizonFrame, marketProxyTicker);
		}
		for (const lookback of LOOKBACKS) {
			const lookbackRows = selectTickerRows(
				sliceRowsToLookback(horizonFrame, lookback.years),
				tickers,
			);
			if (!hasAnyFiniteTickerValue(lookbackRows, tickers)) {
				continue;
			}
			const componentName = `${horizon.name}_${lookback.years}y`;
			const combinedIntentWeight = horizon.intentWeight * lookback.intentWeight;
			inputs.push({
				name: componentName,
				correlationValues: correlationValues(lookbackRows, tickers),
				pairCountValues: pairCounts(lookbackRows, tickers),
				intentWeight: combinedIntentWeight,
				minObservations: horizon.minObservations,
			});
			components[componentName] = {
				rows: lookbackRows.height,
				horizonIntentWeight: horizon.intentWeight,
				lookbackIntentWeight: lookback.intentWeight,
				combinedIntentWeight,
				minObservations: horizon.minObservations,
			};
		}
	}

	const rawMatrix = fisherBlendedCorrelation(tickers, inputs, blendWeightMode);
	const rawValues = valuesFromMatrix(rawMatrix).map((row) =>
		row.map((value) => (Number.isFinite(value) ? value : 0)),
	);
	const symmetricValues = rawValues.map((row, rowIndex) =>
		row.map(
			(value, columnIndex) => (value + rawValues[columnIndex][rowIndex]) / 2,
		),
	);
	const shrunkValues = symmetricValues.map((row, rowIndex) =>
		row.map(
			(value, columnIndex) =>
				(1 - PSD_SHRINKAGE) * value +
				(rowIndex === columnIndex ? PSD_SHRINKAGE : 0),
		),
	);
	const rawEigen = jacobiEigenSymmetric(symmetricValues);
	const shrunkEigen = jacobiEigenSymmetric(shrunkValues);
	const clippedEigenvalues = shrunkEigen.eigenvalues.map((value) =>
		Math.max(value, PSD_EIGENVALUE_FLOOR),
	);
	const psdValues = multiplyMatrices(
		multiplyMatrices(shrunkEigen.eigenvectors, diagonal(clippedEigenvalues)),
		transpose(shrunkEigen.eigenvectors),
	);
	const scales = psdValues.map((row, index) =>
		Math.sqrt(Math.max(row[index], PSD_EIGENVALUE_FLOOR)),
	);
	const normalizedPsdValues = psdValues.map((row, rowIndex) =>
		row.map((value, columnIndex) =>
			Math.max(
				-1,
				Math.min(1, value / (scales[rowIndex] * scales[columnIndex])),
			),
		),
	);
	for (let index = 0; index < normalizedPsdValues.length; index += 1) {
		normalizedPsdValues[index][index] = 1;
	}

	return {
		rawMatrix,
		psdMatrix: matrixFromValues(tickers, normalizedPsdValues),
		diagnostics: {
			components,
			blendWeightMode,
			correlationMode,
			matrixShrinkage: PSD_SHRINKAGE,
			matrixMinEigenvalueRaw: minValue(rawEigen.eigenvalues),
			matrixMinEigenvalueShrunk: minValue(shrunkEigen.eigenvalues),
			matrixMinEigenvaluePsd: minValue(clippedEigenvalues),
		},
	};
}
