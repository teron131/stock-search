import { normalizeTicker } from "../format.js";

const EVAL_KEYS = [
	"overall_score",
	"quality_score",
	"valuation_score",
	"moat_score",
	"upside_score",
	"market_cap_score",
	"rank",
];

function ensureEvalEntries(evalData) {
	if (evalData && typeof evalData === "object") {
		return Object.entries(evalData).map(([ticker, data]) => ({
			...data,
			ticker,
		}));
	}

	return [];
}

function isEtfLikeRow(row) {
	const equityType = String(row?.equity_type ?? "").toUpperCase();
	const quoteType = String(row?.quote_type ?? "").toUpperCase();
	return equityType === "ETF" || quoteType === "ETF";
}

function isProxiedStatCell(row, key) {
	return row?.proxied_stat_fields?.includes?.(key) === true;
}

function clearEtfMarketCap(row) {
	if (!isProxiedStatCell(row, "market_cap")) {
		row.market_cap = null;
	}
	row.fx = null;
}

export function mergeRows(dashData, evalData) {
	const portfolioMap = new Map(
		(dashData.rows || []).map((row) => [normalizeTicker(row.ticker), row]),
	);
	const evalMap = new Map(
		ensureEvalEntries(evalData).map((entry) => [
			normalizeTicker(entry.ticker),
			entry,
		]),
	);
	const allTickers = new Set([...portfolioMap.keys(), ...evalMap.keys()]);

	return Array.from(allTickers).map((ticker) => {
		const portfolioRow = portfolioMap.get(ticker) || {};
		const evalRow = evalMap.get(ticker) || {};
		const safeTicker = portfolioRow.ticker || evalRow.ticker || ticker;
		const merged = { ...portfolioRow };
		Object.entries(evalRow).forEach(([key, value]) => {
			if (merged[key] == null) {
				merged[key] = value;
			}
		});

		merged.ticker = safeTicker;
		merged.name = merged.name || evalRow.name || safeTicker;

		if (merged.notional == null && !isEtfLikeRow(merged)) {
			const total = Number(merged.total);
			if (Number.isFinite(total) && total > 0) {
				merged.notional = {
					from_stocks: total,
					from_etf: 0,
					from_options: 0,
				};
			}
		}

		if (isEtfLikeRow(merged)) {
			clearEtfMarketCap(merged);
			EVAL_KEYS.forEach((key) => {
				merged[key] = null;
			});
		}

		return merged;
	});
}

export function calculateRanks(rows) {
	const out = rows.map((row) => ({ ...row, rank: null }));
	const ranked = rows
		.map((row, index) => ({
			index,
			hasScore: row.overall_score != null && row.overall_score !== "",
			score: Number(row.overall_score),
		}))
		.filter((item) => item.hasScore)
		.filter((item) => Number.isFinite(item.score))
		.sort((a, b) => b.score - a.score);

	ranked.forEach((item, rank) => {
		out[item.index] = { ...out[item.index], rank: rank + 1 };
	});

	return out;
}

export function calculateWeights(rows) {
	const totalVal = rows.reduce((acc, row) => acc + (Number(row.total) || 0), 0);
	if (totalVal <= 0) {
		return {
			totalVal: 0,
			rows: rows.map((row) => ({ ...row, weight_pct: 0 })),
		};
	}

	return {
		totalVal,
		rows: rows.map((row) => {
			const rawTotal = row.total;
			const total = rawTotal == null ? null : Number(rawTotal);
			if (total == null || Number.isNaN(total)) {
				return { ...row, weight_pct: null };
			}
			return { ...row, weight_pct: (total / totalVal) * 100 };
		}),
	};
}

export function calculateWeightedChange(rows, totalVal) {
	if (totalVal <= 0) return { percent: 0, absolute: 0 };

	const absolute = rows.reduce((acc, row) => {
		const changePercent = Number(row.change_percent_1d) || 0;
		const total = Number(row.total) || 0;
		return acc + ((changePercent / 100) * total) / (1 + changePercent / 100);
	}, 0);

	return {
		percent: (absolute / (totalVal - absolute)) * 100,
		absolute,
	};
}

export function calculatePortfolioSummary(rows, portfolioStats) {
	const { totalVal, rows: weighted } = calculateWeights(rows);
	const change = calculateWeightedChange(weighted, totalVal);
	const positions = weighted.filter((row) => Number(row.quantity) > 0).length;
	const derived = {
		totalVal,
		change,
		positions,
		weightedBeta: null,
		weightedIv: null,
		sectorDistribution: [],
	};
	if (!portfolioStats || typeof portfolioStats !== "object") {
		return derived;
	}

	const totalFromApi = Number(portfolioStats.total);
	const changeValueFromApi = Number(portfolioStats.change);
	const changePctFromApi = Number(portfolioStats.change_percent);
	const positionsFromApi = Number(
		portfolioStats.held_positions_count ?? portfolioStats.positions,
	);
	const weightedBetaFromApi = Number(portfolioStats.weighted_beta);
	const weightedIvFromApi = Number(portfolioStats.weighted_iv);

	return {
		totalVal: Number.isFinite(totalFromApi) ? totalFromApi : derived.totalVal,
		change: {
			absolute: Number.isFinite(changeValueFromApi)
				? changeValueFromApi
				: derived.change.absolute,
			percent: Number.isFinite(changePctFromApi)
				? changePctFromApi
				: derived.change.percent,
		},
		positions: Number.isFinite(positionsFromApi)
			? positionsFromApi
			: derived.positions,
		weightedBeta: Number.isFinite(weightedBetaFromApi)
			? weightedBetaFromApi
			: null,
		weightedIv: Number.isFinite(weightedIvFromApi) ? weightedIvFromApi : null,
		sectorDistribution: Array.isArray(portfolioStats.sector_distribution)
			? portfolioStats.sector_distribution
			: [],
	};
}

export function upsertRow(rows, nextRow) {
	const ticker = normalizeTicker(nextRow?.ticker);
	if (!ticker) return rows;

	const index = rows.findIndex(
		(row) => normalizeTicker(row?.ticker) === ticker,
	);
	if (index === -1) return [...rows, nextRow];

	const cloned = [...rows];
	cloned[index] = nextRow;
	return cloned;
}

export function removeRow(rows, ticker) {
	const normalizedTicker = normalizeTicker(ticker);
	return rows.filter(
		(row) => normalizeTicker(row?.ticker) !== normalizedTicker,
	);
}

export function getNormalizedPortfolioStats(dashData) {
	return dashData?.portfolio_stats &&
		typeof dashData.portfolio_stats === "object"
		? dashData.portfolio_stats
		: null;
}

export function getGeneratedAtTimestamp(dashData) {
	return typeof dashData?.generated_at === "string" && dashData.generated_at
		? dashData.generated_at
		: null;
}
