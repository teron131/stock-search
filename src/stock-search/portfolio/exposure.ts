/** Build ETF lookthrough, notional, and sector exposure tables. */

import { safeFloat } from "../common-utils.js";
import type { EtfResolutionResult } from "../etf/index.js";
import { normalizeSectorName } from "../etf/index.js";
import { fetchYahooSymbolMetadata } from "../indicators.js";
import { Notional } from "../models/schemas.js";
import { normalizeTicker } from "../utils.js";
import { isStockLikeEtfRepresentativeTicker } from "./etf-proxy.js";

function normalizeWeightsTo100(
	weights: Record<string, number>,
	decimals = 4,
): Record<string, number> {
	const entries = Object.entries(weights);
	if (entries.length === 0) {
		return {};
	}
	const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
	if (total <= 0) {
		return Object.fromEntries(
			entries.map(([ticker, weight]) => [
				ticker,
				Number(weight.toFixed(decimals)),
			]),
		);
	}
	const rounded = Object.fromEntries(
		entries.map(([ticker, weight]) => [
			ticker,
			Number(weight.toFixed(decimals)),
		]),
	);
	const adjustment = Number(
		(
			100 - Object.values(rounded).reduce((sum, value) => sum + value, 0)
		).toFixed(decimals),
	);
	if (adjustment === 0) {
		return rounded;
	}
	const largestTicker = Object.entries(rounded).sort(
		(left, right) => right[1] - left[1],
	)[0]?.[0];
	if (largestTicker) {
		rounded[largestTicker] = Number(
			(rounded[largestTicker] + adjustment).toFixed(decimals),
		);
	}
	return rounded;
}

export function buildNotionalByTicker(
	rows: Array<Record<string, unknown>>,
	resolution: EtfResolutionResult,
): Record<string, Notional> {
	const notionalByTicker: Record<string, Notional> = {};
	const rowByTicker = new Map(
		rows.map((row) => [normalizeTicker(row.ticker), row] as const),
	);

	for (const row of rows) {
		const ticker = normalizeTicker(row.ticker);
		const total = safeFloat(row.total) ?? 0;
		if (!ticker || total <= 0) {
			continue;
		}
		notionalByTicker[ticker] ??= new Notional();
		notionalByTicker[ticker].addFromStocks(total);
	}

	for (const etfPosition of resolution.etfPositions) {
		const etfTicker = normalizeTicker(etfPosition.ticker);
		const etfTotal = safeFloat(rowByTicker.get(etfTicker)?.total) ?? 0;
		const snapshot = resolution.snapshotByTicker[etfTicker];
		if (etfTotal <= 0 || !snapshot) {
			continue;
		}
		for (const holding of snapshot.holdings) {
			const holdingTicker = normalizeTicker(holding.ticker);
			if (
				!holdingTicker ||
				!isStockLikeEtfRepresentativeTicker(holdingTicker) ||
				!Number.isFinite(holding.weight)
			) {
				continue;
			}
			notionalByTicker[holdingTicker] ??= new Notional();
			notionalByTicker[holdingTicker].addFromEtf(
				etfTotal * (holding.weight / 100),
			);
		}
	}

	return Object.fromEntries(
		Object.entries(notionalByTicker).map(([ticker, notional]) => [
			ticker,
			notional.rounded(),
		]),
	);
}

async function fetchEquitySector(
	ticker: string,
	rowByTicker: Map<string, Record<string, unknown>>,
): Promise<[string, string]> {
	const row = rowByTicker.get(ticker);
	const rawSector =
		typeof row?.sector_name === "string" && row.sector_name.trim()
			? row.sector_name
			: typeof row?.industry_name === "string" && row.industry_name.trim()
				? row.industry_name
				: null;
	if (rawSector) {
		return [ticker, normalizeSectorName(rawSector)];
	}

	const metadata = await fetchYahooSymbolMetadata(ticker);
	return [
		ticker,
		normalizeSectorName(
			typeof metadata.sector_name === "string" && metadata.sector_name.trim()
				? metadata.sector_name
				: typeof metadata.industry_name === "string" &&
						metadata.industry_name.trim()
					? metadata.industry_name
					: null,
		),
	];
}

export async function buildEtfTables(
	rows: Array<Record<string, unknown>>,
	resolution: EtfResolutionResult,
	targetTickers: string[],
	notionalByTicker: Record<string, Notional>,
): Promise<{
	tickerTable: Array<Record<string, unknown>>;
	sectorTable: Array<Record<string, unknown>>;
	meta: Record<string, number>;
}> {
	const rowByTicker = new Map(
		rows.map((row) => [normalizeTicker(row.ticker), row] as const),
	);
	const stockTickers = resolution.stockPositions.map((position) =>
		normalizeTicker(position.ticker),
	);
	const etfTickers = resolution.etfPositions.map((position) =>
		normalizeTicker(position.ticker),
	);
	const exposureTickers = new Set(targetTickers);
	for (const etfTicker of etfTickers) {
		const snapshot = resolution.snapshotByTicker[etfTicker];
		for (const holding of snapshot?.holdings ?? []) {
			const holdingTicker = normalizeTicker(holding.ticker);
			if (holdingTicker && isStockLikeEtfRepresentativeTicker(holdingTicker)) {
				exposureTickers.add(holdingTicker);
			}
		}
	}
	const portfolioTotal = targetTickers.reduce((sum, ticker) => {
		return sum + (safeFloat(rowByTicker.get(ticker)?.total) ?? 0);
	}, 0);
	const directWeights = Object.fromEntries(
		targetTickers.map((ticker) => {
			const total = safeFloat(rowByTicker.get(ticker)?.total) ?? 0;
			return [ticker, portfolioTotal > 0 ? (total / portfolioTotal) * 100 : 0];
		}),
	);
	const etfAllocation = Object.fromEntries(
		etfTickers.map((ticker) => {
			const total = safeFloat(rowByTicker.get(ticker)?.total) ?? 0;
			return [ticker, portfolioTotal > 0 ? (total / portfolioTotal) * 100 : 0];
		}),
	);
	const tickerExposure = Object.fromEntries(
		[...exposureTickers].map((ticker) => [
			ticker,
			{
				direct_weight: directWeights[ticker] ?? 0,
				etf_lookthrough_weight: 0,
				combined_weight: directWeights[ticker] ?? 0,
			},
		]),
	) as Record<
		string,
		{
			direct_weight: number;
			etf_lookthrough_weight: number;
			combined_weight: number;
		}
	>;
	const etfDistributedWeights = Object.fromEntries(
		etfTickers.map((ticker) => [ticker, 0]),
	) as Record<string, number>;
	const etfSectorExposure: Record<string, number> = {};

	for (const etfTicker of etfTickers) {
		const snapshot = resolution.snapshotByTicker[etfTicker];
		if (!snapshot) {
			continue;
		}
		const etfWeight = etfAllocation[etfTicker] ?? 0;
		for (const holding of snapshot.holdings) {
			const holdingTicker = normalizeTicker(holding.ticker);
			if (!holdingTicker || !tickerExposure[holdingTicker]) {
				continue;
			}
			const contribution = etfWeight * (holding.weight / 100);
			tickerExposure[holdingTicker].etf_lookthrough_weight += contribution;
			tickerExposure[holdingTicker].combined_weight += contribution;
			etfDistributedWeights[etfTicker] =
				(etfDistributedWeights[etfTicker] ?? 0) + contribution;
		}
		for (const sector of snapshot.sectors) {
			const contribution = etfWeight * (sector.weight / 100);
			etfSectorExposure[sector.name] =
				(etfSectorExposure[sector.name] ?? 0) + contribution;
		}
	}

	for (const etfTicker of etfTickers) {
		if (tickerExposure[etfTicker]) {
			tickerExposure[etfTicker].combined_weight -=
				etfDistributedWeights[etfTicker] ?? 0;
		}
	}

	const normalizedDirectWeights = normalizeWeightsTo100(
		Object.fromEntries(
			Object.entries(tickerExposure).map(([ticker, data]) => [
				ticker,
				data.direct_weight,
			]),
		),
	);
	const normalizedCombinedWeights = normalizeWeightsTo100(
		Object.fromEntries(
			Object.entries(tickerExposure).map(([ticker, data]) => [
				ticker,
				data.combined_weight,
			]),
		),
	);
	for (const [ticker, data] of Object.entries(tickerExposure)) {
		data.direct_weight = normalizedDirectWeights[ticker] ?? 0;
		data.etf_lookthrough_weight = Number(
			data.etf_lookthrough_weight.toFixed(4),
		);
		data.combined_weight = normalizedCombinedWeights[ticker] ?? 0;
	}

	const stockSectorExposure: Record<string, number> = {};
	const stockSectorResults = await Promise.all(
		[...new Set(stockTickers)].map((ticker) =>
			fetchEquitySector(ticker, rowByTicker),
		),
	);
	for (const [ticker, sector] of stockSectorResults) {
		const directWeight = normalizedDirectWeights[ticker] ?? 0;
		stockSectorExposure[sector] =
			(stockSectorExposure[sector] ?? 0) + directWeight;
	}

	const tickerTable = Object.entries(tickerExposure)
		.map(([ticker, data]) => ({
			ticker,
			direct_weight: Number(data.direct_weight.toFixed(4)),
			etf_lookthrough_weight: Number(data.etf_lookthrough_weight.toFixed(4)),
			combined_weight: Number(data.combined_weight.toFixed(4)),
			notional: notionalByTicker[ticker] ?? new Notional(),
		}))
		.sort((left, right) => right.combined_weight - left.combined_weight);

	const combinedSectorExposure = { ...etfSectorExposure };
	for (const [sector, weight] of Object.entries(stockSectorExposure)) {
		combinedSectorExposure[sector] =
			(combinedSectorExposure[sector] ?? 0) + weight;
	}
	const etfSleeveTotal = Object.values(etfSectorExposure).reduce(
		(sum, value) => sum + value,
		0,
	);
	const sectorTable = Object.entries(combinedSectorExposure)
		.map(([sector, weight]) => ({
			sector,
			stock_weight: Number((stockSectorExposure[sector] ?? 0).toFixed(4)),
			etf_lookthrough_weight: Number(
				(etfSectorExposure[sector] ?? 0).toFixed(4),
			),
			portfolio_weight: Number(weight.toFixed(4)),
			within_etf_sleeve_weight:
				etfSleeveTotal > 0
					? Number(
							(
								((etfSectorExposure[sector] ?? 0) / etfSleeveTotal) *
								100
							).toFixed(4),
						)
					: 0,
		}))
		.sort((left, right) => right.portfolio_weight - left.portfolio_weight);

	return {
		tickerTable,
		sectorTable,
		meta: {
			direct_weight_total: Number(
				tickerTable
					.reduce((sum, row) => sum + Number(row.direct_weight), 0)
					.toFixed(4),
			),
			combined_weight_total: Number(
				tickerTable
					.reduce((sum, row) => sum + Number(row.combined_weight), 0)
					.toFixed(4),
			),
			sector_portfolio_total: Number(
				sectorTable
					.reduce((sum, row) => sum + Number(row.portfolio_weight), 0)
					.toFixed(4),
			),
			within_etf_sleeve_total: Number(
				sectorTable
					.reduce((sum, row) => sum + Number(row.within_etf_sleeve_weight), 0)
					.toFixed(4),
			),
		},
	};
}

export function buildSectorDistribution(
	rows: Array<Record<string, unknown>>,
	resolution: EtfResolutionResult,
): Array<{
	sector: string;
	portfolio_weight: number;
	stock_weight: number;
	etf_lookthrough_weight: number;
}> {
	const directExposure = new Map<string, number>();
	const etfExposure = new Map<string, number>();
	const rowByTicker = new Map(
		rows.map((row) => [normalizeTicker(row.ticker), row] as const),
	);

	for (const row of rows) {
		if (Number(row.quantity ?? 0) <= 0) {
			continue;
		}
		if (String(row.equity_type ?? "").toUpperCase() === "ETF") {
			continue;
		}
		const weight = Number(row.weight_pct ?? 0);
		if (!Number.isFinite(weight) || weight <= 0) {
			continue;
		}
		const sector = normalizeSectorName(
			typeof row.sector_name === "string" ? row.sector_name : null,
		);
		directExposure.set(sector, (directExposure.get(sector) ?? 0) + weight);
	}

	for (const position of resolution.etfPositions) {
		const ticker = normalizeTicker(position.ticker);
		const row = rowByTicker.get(ticker);
		const sleeveWeight = Number(row?.weight_pct ?? 0);
		if (!Number.isFinite(sleeveWeight) || sleeveWeight <= 0) {
			continue;
		}
		const snapshot = resolution.snapshotByTicker[ticker];
		for (const sector of snapshot?.sectors ?? []) {
			const contribution = sleeveWeight * (sector.weight / 100);
			etfExposure.set(
				sector.name,
				(etfExposure.get(sector.name) ?? 0) + contribution,
			);
		}
	}

	const allSectors = new Set([...directExposure.keys(), ...etfExposure.keys()]);
	return [...allSectors]
		.map((sector) => ({
			sector,
			stock_weight: Number((directExposure.get(sector) ?? 0).toFixed(4)),
			etf_lookthrough_weight: Number((etfExposure.get(sector) ?? 0).toFixed(4)),
			portfolio_weight: Number(
				(
					(directExposure.get(sector) ?? 0) + (etfExposure.get(sector) ?? 0)
				).toFixed(4),
			),
		}))
		.sort((left, right) => right.portfolio_weight - left.portfolio_weight);
}
