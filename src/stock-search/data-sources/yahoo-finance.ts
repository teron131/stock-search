/** Yahoo Finance source adapter. */

import { roundOptional } from "../common-utils.js";
import { normalizeTicker } from "../utils.js";
import { fetchJson, toFiniteNumber } from "./shared.js";

export const ETF_QUOTE_TYPE = "ETF";

type YahooChartResponse = {
	chart?: {
		result?: Array<{
			meta?: {
				shortName?: string;
				longName?: string;
				instrumentType?: string;
				regularMarketPrice?: number;
			};
			timestamp?: number[];
			indicators?: {
				quote?: Array<{
					close?: Array<number | null>;
				}>;
			};
		}>;
	};
};

type YahooSearchResponse = {
	quotes?: Array<{
		symbol?: string;
		sector?: string;
		industry?: string;
	}>;
};

type YahooFundamentalsPoint = {
	asOfDate?: string;
	reportedValue?: {
		raw?: number;
	};
};

type YahooFundamentalsEntry = {
	meta?: {
		type?: string[];
	};
	timestamp?: number[];
} & Record<string, YahooFundamentalsPoint[] | { type?: string[] } | number[] | undefined>;

type YahooFundamentalsResponse = {
	timeseries?: {
		result?: YahooFundamentalsEntry[];
	};
};

type YahooQuoteSummaryField = {
	raw?: number | string;
	fmt?: string;
	longFmt?: string;
};

type YahooQuoteSummaryModule = Record<
	string,
	YahooQuoteSummaryField | string | undefined
>;

type YahooQuoteSummaryResponse = {
	quoteSummary?: {
		result?: Array<{
			price?: YahooQuoteSummaryModule;
			summaryDetail?: YahooQuoteSummaryModule;
			defaultKeyStatistics?: YahooQuoteSummaryModule;
			financialData?: YahooQuoteSummaryModule;
			upgradeDowngradeHistory?: {
				history?: Array<{
					epochGradeDate?: number;
					firm?: string;
					toGrade?: string;
					fromGrade?: string;
					action?: string;
					priceTargetAction?: string;
					currentPriceTarget?: number;
					priorPriceTarget?: number;
				}>;
			};
		}>;
	};
};

type YahooInsightsResponse = {
	finance?: {
		result?: {
			instrumentInfo?: {
				recommendation?: {
					targetPrice?: number;
					provider?: string;
					rating?: string;
				};
			};
		};
	};
};

type DatedClose = {
	date: Date;
	close: number;
};

const YAHOO_CHART_URL =
	"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=1y&interval=1d&includePrePost=false";
const YAHOO_INTRADAY_URL =
	"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=1d&interval=5m&includePrePost=true";
const YAHOO_SEARCH_URL =
	"https://query2.finance.yahoo.com/v1/finance/search?q={ticker}";
const YAHOO_INSIGHTS_URL =
	"https://query1.finance.yahoo.com/ws/insights/v1/finance/insights?symbol={ticker}";
const YAHOO_COOKIE_URL = "https://fc.yahoo.com";
const YAHOO_CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";
const YAHOO_BENCHMARK_TICKER = "^GSPC";
const YAHOO_FUNDAMENTALS_FIELDS = [
	"trailingPegRatio",
	"annualDilutedEPS",
	"quarterlyDilutedEPS",
	"quarterlyGrossProfit",
	"annualGrossProfit",
	"quarterlyTotalRevenue",
	"annualTotalRevenue",
	"quarterlyOperatingIncome",
	"annualOperatingIncome",
	"quarterlyFreeCashFlow",
	"annualFreeCashFlow",
	"quarterlyTotalDebt",
	"annualTotalDebt",
	"quarterlyStockholdersEquity",
	"annualStockholdersEquity",
	"quarterlyDilutedAverageShares",
	"annualDilutedAverageShares",
] as const;

function buildYahooFundamentalsUrl(ticker: string): string {
	const period2 = Math.floor(Date.now() / 1000);
	const period1 = period2 - 60 * 60 * 24 * 365 * 3;
	const types = YAHOO_FUNDAMENTALS_FIELDS.join(",");
	return `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(
		ticker,
	)}?type=${encodeURIComponent(types)}&period1=${period1}&period2=${period2}`;
}

function buildYahooQuoteSummaryUrl(ticker: string, crumb: string): string {
	return `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
		ticker,
	)}?modules=price,summaryDetail,defaultKeyStatistics,financialData,upgradeDowngradeHistory&crumb=${encodeURIComponent(
		crumb,
	)}`;
}

function buildSeries(
	timestamps: number[] | undefined,
	closes: Array<number | null> | undefined,
): DatedClose[] {
	if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
		return [];
	}
	const series: DatedClose[] = [];
	for (const [index, timestamp] of timestamps.entries()) {
		const close = toFiniteNumber(closes[index]);
		if (close == null || !Number.isFinite(timestamp)) {
			continue;
		}
		series.push({
			date: new Date(timestamp * 1000),
			close,
		});
	}
	return series;
}

function subtractMonths(date: Date, months: number): Date {
	return new Date(
		Date.UTC(
			date.getUTCFullYear(),
			date.getUTCMonth() - months,
			date.getUTCDate(),
		),
	);
}

function lastCloseAtOrBefore(series: DatedClose[], target: Date): number | null {
	for (let index = series.length - 1; index >= 0; index -= 1) {
		if (series[index].date.getTime() <= target.getTime()) {
			return series[index].close;
		}
	}
	return series[0]?.close ?? null;
}

function percentChange(current: number, previous: number | null): number | null {
	if (previous == null || previous === 0) {
		return null;
	}
	return ((current - previous) / previous) * 100;
}

function percentGrowth(current: number | null, previous: number | null): number | null {
	if (current == null || previous == null || previous === 0) {
		return null;
	}
	return ((current / previous) - 1) * 100;
}

function getSetCookieHeaders(headers: Headers): string[] {
	const candidate = headers as Headers & {
		getSetCookie?: () => string[];
	};
	if (typeof candidate.getSetCookie === "function") {
		return candidate.getSetCookie();
	}
	const single = headers.get("set-cookie");
	return single ? [single] : [];
}

function mergeCookieHeaders(...cookieGroups: string[][]): string {
	const cookiesByName = new Map<string, string>();
	for (const cookieGroup of cookieGroups) {
		for (const cookie of cookieGroup) {
			const pair = cookie.split(";", 1)[0]?.trim();
			if (!pair) {
				continue;
			}
			const separatorIndex = pair.indexOf("=");
			if (separatorIndex <= 0) {
				continue;
			}
			cookiesByName.set(pair.slice(0, separatorIndex), pair);
		}
	}
	return [...cookiesByName.values()].join("; ");
}

function sampleStandardDeviation(values: number[]): number | null {
	if (values.length < 2) {
		return null;
	}
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	const variance =
		values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
		(values.length - 1);
	return Number.isFinite(variance) ? Math.sqrt(variance) : null;
}

function computeIv(series: DatedClose[]): number | null {
	if (series.length < 2) {
		return null;
	}

	const logReturns: number[] = [];
	for (let index = 1; index < series.length; index += 1) {
		const previous = series[index - 1]?.close;
		const current = series[index]?.close;
		if (
			previous == null ||
			current == null ||
			previous <= 0 ||
			current <= 0
		) {
			continue;
		}
		logReturns.push(Math.log(current / previous));
	}

	if (logReturns.length === 0) {
		return null;
	}

	const windowsToWeights: Array<[number, number]> = [
		[180, 5],
		[90, 4],
		[30, 3],
		[7, 2],
		[1, 1],
	];
	let weightedSum = 0;
	let totalWeight = 0;
	for (const [window, weight] of windowsToWeights) {
		const values = logReturns.slice(-window);
		const deviation = sampleStandardDeviation(values);
		if (deviation == null) {
			continue;
		}
		const annualizedHv = deviation * Math.sqrt(252) * 100;
		weightedSum += annualizedHv * weight;
		totalWeight += weight;
	}

	return totalWeight > 0 ? weightedSum / totalWeight : null;
}

function computeRsi(series: DatedClose[], period = 14): number | null {
	if (series.length <= period) {
		return null;
	}

	let gains = 0;
	let losses = 0;
	for (let index = series.length - period; index < series.length; index += 1) {
		const previous = series[index - 1]?.close;
		const current = series[index]?.close;
		if (previous == null || current == null) {
			continue;
		}
		const delta = current - previous;
		if (delta >= 0) {
			gains += delta;
		} else {
			losses -= delta;
		}
	}

	if (losses === 0) {
		return gains > 0 ? 100 : 50;
	}

	const averageGain = gains / period;
	const averageLoss = losses / period;
	if (averageLoss === 0) {
		return 100;
	}
	const relativeStrength = averageGain / averageLoss;
	return 100 - 100 / (1 + relativeStrength);
}

function firstDayOfMonth(date: Date): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function firstDayOfYear(date: Date): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

function toDateKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function dailyReturnsMap(series: DatedClose[]): Map<string, number> {
	const returns = new Map<string, number>();
	for (let index = 1; index < series.length; index += 1) {
		const previous = series[index - 1]?.close;
		const current = series[index]?.close;
		if (
			previous == null ||
			current == null ||
			previous <= 0 ||
			current <= 0
		) {
			continue;
		}
		returns.set(toDateKey(series[index].date), (current / previous) - 1);
	}
	return returns;
}

function computeBeta(
	series: DatedClose[],
	benchmarkSeries: DatedClose[],
): number | null {
	const stockReturns = dailyReturnsMap(series);
	const benchmarkReturns = dailyReturnsMap(benchmarkSeries);
	const aligned: Array<[number, number]> = [];

	for (const [dateKey, stockReturn] of stockReturns.entries()) {
		const benchmarkReturn = benchmarkReturns.get(dateKey);
		if (benchmarkReturn == null) {
			continue;
		}
		aligned.push([stockReturn, benchmarkReturn]);
	}

	if (aligned.length < 2) {
		return null;
	}

	const stockMean =
		aligned.reduce((sum, [stockReturn]) => sum + stockReturn, 0) /
		aligned.length;
	const benchmarkMean =
		aligned.reduce((sum, [, benchmarkReturn]) => sum + benchmarkReturn, 0) /
		aligned.length;
	let covariance = 0;
	let benchmarkVariance = 0;
	for (const [stockReturn, benchmarkReturn] of aligned) {
		covariance +=
			(stockReturn - stockMean) * (benchmarkReturn - benchmarkMean);
		benchmarkVariance += (benchmarkReturn - benchmarkMean) ** 2;
	}
	if (benchmarkVariance === 0) {
		return null;
	}
	return roundOptional(covariance / benchmarkVariance, 2);
}

function quoteSummaryNumberField(
	modules: Array<YahooQuoteSummaryModule | undefined>,
	fieldName: string,
): number | null {
	for (const module of modules) {
		const value = module?.[fieldName];
		if (value && typeof value === "object") {
			const rawValue = toFiniteNumber(value.raw);
			if (rawValue != null) {
				return rawValue;
			}
		}
	}
	return null;
}

function quoteSummaryStringField(
	modules: Array<YahooQuoteSummaryModule | undefined>,
	fieldName: string,
): string | null {
	for (const module of modules) {
		const value = module?.[fieldName];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return null;
}

function selectRealtimePriceEntry(priceModule: YahooQuoteSummaryModule | undefined): {
	key: string | null;
	price: number | null;
} {
	if (!priceModule) {
		return { key: null, price: null };
	}

	const candidates = [
		{
			key: "preMarketPrice",
			time: toFiniteNumber(priceModule.preMarketTime),
			price: quoteSummaryNumberField([priceModule], "preMarketPrice"),
		},
		{
			key: "regularMarketPrice",
			time: toFiniteNumber(priceModule.regularMarketTime),
			price: quoteSummaryNumberField([priceModule], "regularMarketPrice"),
		},
		{
			key: "postMarketPrice",
			time: toFiniteNumber(priceModule.postMarketTime),
			price: quoteSummaryNumberField([priceModule], "postMarketPrice"),
		},
	].filter(
		(candidate): candidate is {
			key: string;
			time: number | null;
			price: number;
		} => candidate.price != null,
	);

	if (candidates.some((candidate) => candidate.time != null && candidate.time > 0)) {
		const latestCandidate = candidates.reduce((best, candidate) => {
			const candidateTime = candidate.time ?? 0;
			const bestTime = best?.time ?? 0;
			return candidateTime >= bestTime ? candidate : best;
		}, candidates[0]);
		return {
			key: latestCandidate.key,
			price: latestCandidate.price,
		};
	}

	const marketState = quoteSummaryStringField([priceModule], "marketState");
	const preferredKey =
		marketState === "PRE"
			? "preMarketPrice"
			: marketState === "POST" ||
				  marketState === "POSTPOST" ||
				  marketState === "CLOSED" ||
				  marketState === "PREPRE"
				? "postMarketPrice"
				: "regularMarketPrice";
	for (const key of [preferredKey, "regularMarketPrice", "postMarketPrice", "preMarketPrice"]) {
		const price = quoteSummaryNumberField([priceModule], key);
		if (price != null) {
			return { key, price };
		}
	}

	return { key: null, price: null };
}

function buildSessionMarketData(
	priceModule: YahooQuoteSummaryModule | undefined,
	fallbackCurrentPrice: number | null,
	fallbackPreviousClose: number | null,
): {
	currentPrice: number | null;
	change: number | null;
	changePercent1d: number | null;
} {
	const priceEntry = selectRealtimePriceEntry(priceModule);
	const currentPrice = priceEntry.price ?? fallbackCurrentPrice;
	let baseline =
		quoteSummaryNumberField([priceModule], "regularMarketPreviousClose") ??
		fallbackPreviousClose;
	if (
		priceEntry.key === "preMarketPrice" ||
		priceEntry.key === "postMarketPrice"
	) {
		baseline =
			quoteSummaryNumberField([priceModule], "regularMarketPrice") ?? baseline;
	}

	return {
		currentPrice,
		change:
			currentPrice != null && baseline != null
				? roundOptional(currentPrice - baseline)
				: null,
		changePercent1d:
			currentPrice != null && baseline != null && baseline !== 0
				? roundOptional(((currentPrice - baseline) / baseline) * 100)
				: null,
	};
}

function buildRatingsSnapshot(
	quoteSummaryPayload: YahooQuoteSummaryResponse | null,
	currentPrice: number | null,
): {
	medianUpside: number | null;
	ratings: Array<Record<string, unknown>> | null;
} {
	const history =
		quoteSummaryPayload?.quoteSummary?.result?.[0]?.upgradeDowngradeHistory
			?.history ?? [];
	if (history.length === 0 || currentPrice == null || currentPrice === 0) {
		return {
			medianUpside: null,
			ratings: null,
		};
	}

	const cutoffEpoch = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
	const recentHistory = history.filter((entry) => {
		const epoch = toFiniteNumber(entry.epochGradeDate);
		return epoch != null && epoch >= cutoffEpoch;
	});
	if (recentHistory.length === 0) {
		return {
			medianUpside: null,
			ratings: null,
		};
	}

	const upsidePercents = recentHistory
		.map((entry) => {
			const target = toFiniteNumber(entry.currentPriceTarget);
			return target != null ? ((target - currentPrice) / currentPrice) * 100 : null;
		})
		.filter((value): value is number => value != null)
		.sort((left, right) => left - right);
	const medianUpside =
		upsidePercents.length === 0
			? null
			: upsidePercents.length % 2 === 1
				? upsidePercents[(upsidePercents.length - 1) / 2]
				: (upsidePercents[upsidePercents.length / 2 - 1] +
						upsidePercents[upsidePercents.length / 2]) /
					2;

	return {
		medianUpside: roundOptional(medianUpside),
		ratings: recentHistory.map((entry) => ({
			Firm: entry.firm ?? null,
			ToGrade: entry.toGrade ?? null,
			FromGrade: entry.fromGrade ?? null,
			Action: entry.action ?? null,
			priceTargetAction: entry.priceTargetAction ?? null,
			currentPriceTarget: toFiniteNumber(entry.currentPriceTarget),
			priorPriceTarget: toFiniteNumber(entry.priorPriceTarget),
		})),
	};
}

async function fetchYahooQuoteSummary(
	ticker: string,
): Promise<YahooQuoteSummaryResponse | null> {
	try {
		const cookieResponse = await fetch(YAHOO_COOKIE_URL, {
			headers: { "user-agent": "Mozilla/5.0" },
		});
		const cookieHeaders = getSetCookieHeaders(cookieResponse.headers);
		const crumbResponse = await fetch(YAHOO_CRUMB_URL, {
			headers: {
				"user-agent": "Mozilla/5.0",
				cookie: mergeCookieHeaders(cookieHeaders),
			},
		});
		if (!crumbResponse.ok) {
			return null;
		}
		const crumb = (await crumbResponse.text()).trim();
		if (!crumb) {
			return null;
		}
		const quoteSummaryResponse = await fetch(
			buildYahooQuoteSummaryUrl(ticker, crumb),
			{
				headers: {
					"user-agent": "Mozilla/5.0",
					cookie: mergeCookieHeaders(
						cookieHeaders,
						getSetCookieHeaders(crumbResponse.headers),
					),
				},
			},
		);
		if (!quoteSummaryResponse.ok) {
			return null;
		}
		return (await quoteSummaryResponse.json()) as YahooQuoteSummaryResponse;
	} catch {
		return null;
	}
}

function pointsForType(
	payload: YahooFundamentalsResponse | null,
	typeName: string,
): YahooFundamentalsPoint[] {
	const entry = (payload?.timeseries?.result ?? []).find((candidate) => {
		const candidateType = candidate.meta?.type?.[0];
		return candidateType === typeName;
	});
	const values = entry?.[typeName];
	return Array.isArray(values)
		? values.filter(
				(value): value is YahooFundamentalsPoint =>
					typeof value === "object" && value !== null,
			)
		: [];
}

function pointValue(point: YahooFundamentalsPoint | undefined): number | null {
	return toFiniteNumber(point?.reportedValue?.raw);
}

function latestPointValue(points: YahooFundamentalsPoint[]): number | null {
	return pointValue(points[points.length - 1]);
}

function sumTrailingValues(
	points: YahooFundamentalsPoint[],
	count: number,
): number | null {
	if (points.length < count) {
		return null;
	}
	let total = 0;
	for (const point of points.slice(-count)) {
		const value = pointValue(point);
		if (value == null) {
			return null;
		}
		total += value;
	}
	return total;
}

function computeMarginPercent(
	numeratorPoints: YahooFundamentalsPoint[],
	denominatorPoints: YahooFundamentalsPoint[],
	annualNumeratorPoints: YahooFundamentalsPoint[],
	annualDenominatorPoints: YahooFundamentalsPoint[],
): number | null {
	const numeratorTtm = sumTrailingValues(numeratorPoints, 4);
	const denominatorTtm = sumTrailingValues(denominatorPoints, 4);
	if (numeratorTtm != null && denominatorTtm != null && denominatorTtm !== 0) {
		return roundOptional((numeratorTtm / denominatorTtm) * 100);
	}

	const annualNumerator = latestPointValue(annualNumeratorPoints);
	const annualDenominator = latestPointValue(annualDenominatorPoints);
	if (
		annualNumerator == null ||
		annualDenominator == null ||
		annualDenominator === 0
	) {
		return null;
	}
	return roundOptional((annualNumerator / annualDenominator) * 100);
}

function computeDilutedEps(
	quarterlyPoints: YahooFundamentalsPoint[],
	annualPoints: YahooFundamentalsPoint[],
): number | null {
	const trailing = sumTrailingValues(quarterlyPoints, 4);
	if (trailing != null) {
		return roundOptional(trailing);
	}
	return roundOptional(latestPointValue(annualPoints));
}

function buildFundamentalsSnapshot(
	payload: YahooFundamentalsResponse | null,
	quoteSummaryPayload: YahooQuoteSummaryResponse | null,
	currentPrice: number | null,
	series: DatedClose[],
	benchmarkSeries: DatedClose[],
): Record<string, unknown> {
	const quoteSummary = quoteSummaryPayload?.quoteSummary?.result?.[0] ?? null;
	const priceModule = quoteSummary?.price;
	const summaryDetailModule = quoteSummary?.summaryDetail;
	const defaultKeyStatisticsModule = quoteSummary?.defaultKeyStatistics;
	const financialDataModule = quoteSummary?.financialData;
	const quarterlyRevenue = pointsForType(payload, "quarterlyTotalRevenue");
	const annualRevenue = pointsForType(payload, "annualTotalRevenue");
	const quarterlyGrossProfit = pointsForType(payload, "quarterlyGrossProfit");
	const annualGrossProfit = pointsForType(payload, "annualGrossProfit");
	const quarterlyOperatingIncome = pointsForType(
		payload,
		"quarterlyOperatingIncome",
	);
	const annualOperatingIncome = pointsForType(payload, "annualOperatingIncome");
	const quarterlyDilutedEps = pointsForType(payload, "quarterlyDilutedEPS");
	const annualDilutedEps = pointsForType(payload, "annualDilutedEPS");
	const quarterlyFreeCashFlow = pointsForType(payload, "quarterlyFreeCashFlow");
	const annualFreeCashFlow = pointsForType(payload, "annualFreeCashFlow");
	const quarterlyTotalDebt = pointsForType(payload, "quarterlyTotalDebt");
	const annualTotalDebt = pointsForType(payload, "annualTotalDebt");
	const quarterlyEquity = pointsForType(payload, "quarterlyStockholdersEquity");
	const annualEquity = pointsForType(payload, "annualStockholdersEquity");
	const quarterlyShares = pointsForType(payload, "quarterlyDilutedAverageShares");
	const annualShares = pointsForType(payload, "annualDilutedAverageShares");
	const epsDiluted = computeDilutedEps(quarterlyDilutedEps, annualDilutedEps);
	const annualRevenueLatest = latestPointValue(annualRevenue);
	const annualRevenuePrevious =
		annualRevenue.length >= 2
			? pointValue(annualRevenue[annualRevenue.length - 2])
			: null;
	const quarterlyRevenueLatest = latestPointValue(quarterlyRevenue);
	const quarterlyRevenuePriorYear =
		quarterlyRevenue.length >= 5
			? pointValue(quarterlyRevenue[quarterlyRevenue.length - 5])
			: null;
	const debt = latestPointValue(quarterlyTotalDebt) ?? latestPointValue(annualTotalDebt);
	const equity = latestPointValue(quarterlyEquity) ?? latestPointValue(annualEquity);
	const dilutedShares =
		latestPointValue(quarterlyShares) ?? latestPointValue(annualShares);
	const trailingFreeCashFlow =
		quoteSummaryNumberField([financialDataModule], "freeCashflow") ??
		sumTrailingValues(quarterlyFreeCashFlow, 4) ??
		latestPointValue(annualFreeCashFlow);
	const forwardEps = quoteSummaryNumberField(
		[defaultKeyStatisticsModule],
		"forwardEps",
	);
	const grossMargin = computeMarginPercent(
		quarterlyGrossProfit,
		quarterlyRevenue,
		annualGrossProfit,
		annualRevenue,
	);
	const operatingMargin = computeMarginPercent(
		quarterlyOperatingIncome,
		quarterlyRevenue,
		annualOperatingIncome,
		annualRevenue,
	);

	return {
		market_cap:
			quoteSummaryNumberField([priceModule, summaryDetailModule], "marketCap") ??
			(currentPrice != null && dilutedShares != null
				? Math.round(currentPrice * dilutedShares)
				: null),
		pe:
			roundOptional(quoteSummaryNumberField([summaryDetailModule], "trailingPE"), 2) ??
			(currentPrice != null && epsDiluted != null && epsDiluted !== 0
				? roundOptional(currentPrice / epsDiluted, 2)
				: null),
		pe_forward:
			roundOptional(
				quoteSummaryNumberField(
					[summaryDetailModule, defaultKeyStatisticsModule],
					"forwardPE",
				),
				2,
			) ??
			(currentPrice != null && forwardEps != null && forwardEps !== 0
				? roundOptional(currentPrice / forwardEps, 2)
				: null),
		peg: roundOptional(latestPointValue(pointsForType(payload, "trailingPegRatio")), 2),
		beta:
			roundOptional(
				quoteSummaryNumberField(
					[summaryDetailModule, defaultKeyStatisticsModule],
					"beta",
				),
				2,
			) ??
			roundOptional(
				quoteSummaryNumberField([defaultKeyStatisticsModule], "beta3Year"),
				2,
			) ??
			computeBeta(series, benchmarkSeries),
		revenue_growth: roundOptional(
			quoteSummaryNumberField([financialDataModule], "revenueGrowth") != null
				? quoteSummaryNumberField([financialDataModule], "revenueGrowth")! * 100
				: percentGrowth(
						quarterlyRevenueLatest ?? annualRevenueLatest,
						quarterlyRevenuePriorYear ?? annualRevenuePrevious,
					),
		),
		gross_margin: grossMargin,
		operating_margin: operatingMargin,
		debt_to_equity:
			quoteSummaryNumberField([financialDataModule], "debtToEquity") ??
			(debt != null && equity != null && equity !== 0
				? roundOptional((debt / equity) * 100)
				: null),
		free_cash_flow: trailingFreeCashFlow,
		eps_diluted: epsDiluted,
	};
}

function buildRatingsPayload(
	recommendation:
		| {
				targetPrice?: number;
				provider?: string;
				rating?: string;
		  }
		| undefined,
): Array<Record<string, unknown>> | null {
	if (!recommendation) {
		return null;
	}
	const targetPrice = toFiniteNumber(recommendation.targetPrice);
	const provider =
		typeof recommendation.provider === "string" &&
		recommendation.provider.trim()
			? recommendation.provider.trim()
			: null;
	const rating =
		typeof recommendation.rating === "string" && recommendation.rating.trim()
			? recommendation.rating.trim()
			: null;
	if (targetPrice == null && provider == null && rating == null) {
		return null;
	}
	return [
		{
			firm: provider,
			to_grade: rating,
			action: "main",
			price_target: targetPrice,
		},
	];
}

export function normalizeYahooTicker(ticker: string): string {
	return normalizeTicker(ticker).replace(/ /g, "-").replace(/\./g, "-");
}

export class YahooFinanceSource {
	/** Initialize the Yahoo adapter for a single ticker. */
	constructor(private readonly ticker: string) {}

	/** Fetch indicator-shaped Yahoo fields for one ticker. */
	async getIndicatorsSnapshot(): Promise<Record<string, unknown>> {
		const ticker = normalizeYahooTicker(this.ticker);
		const [
			payload,
			intradayPayload,
			insightsPayload,
			fundamentalsPayload,
			quoteSummaryPayload,
			benchmarkPayload,
		] = await Promise.all([
			fetchJson<YahooChartResponse>(
				YAHOO_CHART_URL.replace("{ticker}", encodeURIComponent(ticker)),
			),
			fetchJson<YahooChartResponse>(
				YAHOO_INTRADAY_URL.replace("{ticker}", encodeURIComponent(ticker)),
			),
			fetchJson<YahooInsightsResponse>(
				YAHOO_INSIGHTS_URL.replace("{ticker}", encodeURIComponent(ticker)),
			),
			fetchJson<YahooFundamentalsResponse>(buildYahooFundamentalsUrl(ticker)),
			fetchYahooQuoteSummary(ticker),
			fetchJson<YahooChartResponse>(
				YAHOO_CHART_URL.replace(
					"{ticker}",
					encodeURIComponent(YAHOO_BENCHMARK_TICKER),
				),
			),
		]);
		const result = payload?.chart?.result?.[0];
		const intradayResult = intradayPayload?.chart?.result?.[0];
		const meta = result?.meta ?? {};
		const series = buildSeries(
			result?.timestamp,
			result?.indicators?.quote?.[0]?.close,
		);
		const intradaySeries = buildSeries(
			intradayResult?.timestamp,
			intradayResult?.indicators?.quote?.[0]?.close,
		);
		const benchmarkSeries = buildSeries(
			benchmarkPayload?.chart?.result?.[0]?.timestamp,
			benchmarkPayload?.chart?.result?.[0]?.indicators?.quote?.[0]?.close,
		);
		const previous = series[series.length - 2]?.close ?? null;
		const intradayLatest = intradaySeries[intradaySeries.length - 1]?.close ?? null;
		const fallbackCurrentPrice =
			intradayLatest ??
			toFiniteNumber(intradayResult?.meta?.regularMarketPrice) ??
			toFiniteNumber(meta.regularMarketPrice) ??
			series[series.length - 1]?.close ??
			null;
		const sessionMarketData = buildSessionMarketData(
			quoteSummaryPayload?.quoteSummary?.result?.[0]?.price,
			fallbackCurrentPrice,
			previous,
		);
		const currentPrice = sessionMarketData.currentPrice;
		const ratingsSnapshot = buildRatingsSnapshot(
			quoteSummaryPayload,
			quoteSummaryNumberField(
				[quoteSummaryPayload?.quoteSummary?.result?.[0]?.price],
				"regularMarketPrice",
			) ?? currentPrice,
		);
		const fundamentals = buildFundamentalsSnapshot(
			fundamentalsPayload,
			quoteSummaryPayload,
			currentPrice,
			series,
			benchmarkSeries,
		);
		const latest = series[series.length - 1] ?? null;
		const name =
			quoteSummaryStringField(
				[quoteSummaryPayload?.quoteSummary?.result?.[0]?.price],
				"longName",
			) ??
			quoteSummaryStringField(
				[quoteSummaryPayload?.quoteSummary?.result?.[0]?.price],
				"shortName",
			) ??
			meta.longName ??
			meta.shortName ??
			ticker;
		const quoteType =
			quoteSummaryStringField(
				[quoteSummaryPayload?.quoteSummary?.result?.[0]?.price],
				"quoteType",
			) ??
			meta.instrumentType ??
			null;

		return {
			name,
			quote_type: quoteType,
			price: currentPrice,
			change: sessionMarketData.change,
			change_percent_1d: sessionMarketData.changePercent1d,
			change_percent_1m:
				currentPrice != null
					? percentChange(
							currentPrice,
							latest
								? lastCloseAtOrBefore(series, subtractMonths(latest.date, 1))
								: null,
						)
					: null,
			change_percent_3m:
				currentPrice != null
					? percentChange(
							currentPrice,
							latest
								? lastCloseAtOrBefore(series, subtractMonths(latest.date, 3))
								: null,
						)
					: null,
			change_percent_6m:
				currentPrice != null
					? percentChange(
							currentPrice,
							latest
								? lastCloseAtOrBefore(series, subtractMonths(latest.date, 6))
								: null,
						)
					: null,
			change_percent_1y:
				currentPrice != null
					? percentChange(
							currentPrice,
							latest
								? lastCloseAtOrBefore(series, subtractMonths(latest.date, 12))
								: null,
						)
					: null,
			change_percent_mtd:
				currentPrice != null
					? percentChange(
							currentPrice,
							latest
								? lastCloseAtOrBefore(series, firstDayOfMonth(latest.date))
								: null,
						)
					: null,
			change_percent_ytd:
				currentPrice != null
					? percentChange(
							currentPrice,
							latest
								? lastCloseAtOrBefore(series, firstDayOfYear(latest.date))
								: null,
						)
					: null,
			iv: computeIv(series),
			rsi: computeRsi(series),
			median_upside: ratingsSnapshot.medianUpside,
			ratings: ratingsSnapshot.ratings,
			...fundamentals,
		};
	}

	/** Fetch symbol metadata fields that Yahoo search exposes for a ticker. */
	async getSymbolMetadataSnapshot(): Promise<Record<string, unknown>> {
		const ticker = normalizeYahooTicker(this.ticker);
		const payload = await fetchJson<YahooSearchResponse>(
			YAHOO_SEARCH_URL.replace("{ticker}", encodeURIComponent(ticker)),
		);
		const quote = (payload?.quotes ?? []).find(
			(entry) => normalizeTicker(entry?.symbol) === ticker,
		);
		return {
			sector_name:
				typeof quote?.sector === "string" && quote.sector.trim()
					? quote.sector.trim()
					: null,
			industry_name:
				typeof quote?.industry === "string" && quote.industry.trim()
					? quote.industry.trim()
					: null,
		};
	}
}
