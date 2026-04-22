/** Resolve ETF holdings and sector snapshots with cache support. */

import {
	StockAnalysisSource,
	type StockAnalysisEtfSnapshot,
} from "./data-sources/stockanalysis/index.js";
import { ETF_QUOTE_TYPE, YahooFinanceSource } from "./data-sources/yahoo-finance.js";
import type { BackendStore, PositionRow, StockEntry } from "./api/data-store.js";
import { SECTOR_LABELS, SECTOR_PATTERN_RULES } from "./models/labels.js";
import { normalizeTicker } from "./utils.js";

export type EtfHolding = {
	ticker: string;
	name: string | null;
	weight: number;
};

export type EtfSector = {
	name: string;
	weight: number;
};

export type EtfSnapshotResult = {
	holdings: EtfHolding[];
	sectors: EtfSector[];
	error: string | null;
};

export type EtfResolutionResult = {
	stockPositions: PositionRow[];
	etfPositions: PositionRow[];
	snapshotByTicker: Record<string, EtfSnapshotResult>;
	etfRefreshedCount: number;
	cacheChanged: boolean;
	changedTickers: string[];
};

const ETF_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
function parseTimestamp(value: unknown): number | null {
	if (typeof value !== "string" || !value.trim()) {
		return null;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

/** Normalize sector labels into the stable display values used by the app. */
export function normalizeSectorName(value: string | null | undefined): string {
	const sectorText = String(value ?? "").trim();
	if (!sectorText) {
		return SECTOR_LABELS.other;
	}
	for (const label of Object.values(SECTOR_LABELS)) {
		if (sectorText.toLowerCase() === label.toLowerCase()) {
			return label;
		}
	}
	for (const [pattern, label] of SECTOR_PATTERN_RULES) {
		if (new RegExp(pattern, "i").test(sectorText)) {
			return label;
		}
	}
	return SECTOR_LABELS.other;
}

function loadEtfCache(
	indicators: Record<string, unknown>,
	now: number,
	requireFresh: boolean,
): { holdings: EtfHolding[]; sectors: EtfSector[] } | null {
	const fetchedAt = parseTimestamp(indicators.etf_holdings_fetched_at);
	if (requireFresh && (fetchedAt == null || fetchedAt < now - ETF_CACHE_MAX_AGE_MS)) {
		return null;
	}
	if (!Array.isArray(indicators.etf_holdings)) {
		return null;
	}

	const holdings = indicators.etf_holdings
		.filter((holding) => typeof holding === "object" && holding !== null)
		.map((holding) => holding as Record<string, unknown>)
		.map((holding) => ({
			ticker: normalizeTicker(holding.ticker),
			name:
				typeof holding.name === "string" && holding.name.trim()
					? holding.name.trim()
					: null,
			weight: Number(holding.weight),
		}))
		.filter((holding) => holding.ticker && Number.isFinite(holding.weight));
	const sectors = Array.isArray(indicators.etf_sectors)
		? indicators.etf_sectors
				.filter((sector) => typeof sector === "object" && sector !== null)
				.map((sector) => sector as Record<string, unknown>)
				.map((sector) => ({
					name: normalizeSectorName(
						typeof sector.name === "string" ? sector.name : null,
					),
					weight: Number(sector.weight),
				}))
				.filter((sector) => Number.isFinite(sector.weight))
		: [];

	return { holdings, sectors };
}

function storeEtfCache(
	indicators: Record<string, unknown>,
	holdings: EtfHolding[],
	sectors: EtfSector[],
	now: number,
): Record<string, unknown> {
	return {
		...indicators,
		etf_holdings: holdings,
		etf_sectors: sectors,
		etf_holdings_fetched_at: new Date(now).toISOString(),
	};
}

/** Fetch one ETF holdings snapshot from StockAnalysis. */
export async function getEtfSnapshot(
	tickerInput: string,
): Promise<{ holdings: EtfHolding[]; sectors: EtfSector[]; error: string | null }> {
	const ticker = normalizeTicker(tickerInput);
	const snapshot: StockAnalysisEtfSnapshot =
		await new StockAnalysisSource(ticker).getEtfHoldingsSnapshot();
	return {
		holdings: snapshot.holdings,
		sectors: snapshot.sectors.map((sector) => ({
			name: normalizeSectorName(sector.name),
			weight: sector.weight,
		})),
		error: snapshot.error,
	};
}

async function isEtfTicker(
	ticker: string,
	stockEntry: StockEntry | null,
): Promise<boolean> {
	const cachedQuoteType = String(stockEntry?.indicators.quote_type ?? "")
		.trim()
		.toUpperCase();
	if (cachedQuoteType) {
		return cachedQuoteType === ETF_QUOTE_TYPE;
	}
	const liveIndicators = await new YahooFinanceSource(ticker).getIndicatorsSnapshot();
	return String(liveIndicators.quote_type ?? "").toUpperCase() === ETF_QUOTE_TYPE;
}

/** Split held positions into ETF and stock groups and resolve ETF snapshots. */
export async function classifyAndResolveEtfs(
	store: BackendStore,
	positions: PositionRow[],
	stockMap: Record<string, StockEntry>,
	allowLiveFetch: boolean,
): Promise<EtfResolutionResult> {
	const stockPositions: PositionRow[] = [];
	const etfPositions: PositionRow[] = [];
	const snapshotByTicker: Record<string, EtfSnapshotResult> = {};
	const changedTickers = new Set<string>();
	let etfRefreshedCount = 0;
	let cacheChanged = false;
	const now = Date.now();

	for (const position of positions) {
		const ticker = normalizeTicker(position.ticker);
		if (!ticker || Number(position.quantity ?? 0) <= 0) {
			continue;
		}

		const stockEntry = stockMap[ticker] ?? null;
		const indicators = stockEntry?.indicators ?? {};
		const cachedSnapshot = loadEtfCache(indicators, now, true);
		const staleSnapshot = loadEtfCache(indicators, now, false);
		const etfLike =
			String(indicators.quote_type ?? "").trim().toUpperCase() === ETF_QUOTE_TYPE ||
			(cachedSnapshot != null && cachedSnapshot.holdings.length > 0) ||
			(allowLiveFetch && (await isEtfTicker(ticker, stockEntry)));

		if (!etfLike) {
			stockPositions.push(position);
			if (
				String(indicators.quote_type ?? "").trim().toUpperCase() !== "EQUITY" &&
				allowLiveFetch
			) {
				await store.upsertStocks([
					{
						ticker,
						indicators: { ...indicators, quote_type: "EQUITY" },
						evaluation: stockEntry?.evaluation ?? {},
						labels: stockEntry?.labels ?? [],
					},
				]);
			}
			continue;
		}

		etfPositions.push(position);
		if (cachedSnapshot) {
			snapshotByTicker[ticker] = {
				holdings: cachedSnapshot.holdings,
				sectors: cachedSnapshot.sectors,
				error: null,
			};
			continue;
		}
		if (!allowLiveFetch && staleSnapshot) {
			snapshotByTicker[ticker] = {
				holdings: staleSnapshot.holdings,
				sectors: staleSnapshot.sectors,
				error: null,
			};
			continue;
		}

		const snapshot = await getEtfSnapshot(ticker);
		if (!snapshot.error) {
			etfRefreshedCount += 1;
			const nextIndicators = storeEtfCache(
				{ ...indicators, quote_type: ETF_QUOTE_TYPE },
				snapshot.holdings,
				snapshot.sectors,
				now,
			);
			await store.upsertStocks([
				{
					ticker,
					indicators: nextIndicators,
					evaluation: stockEntry?.evaluation ?? {},
					labels: stockEntry?.labels ?? [],
				},
			]);
			cacheChanged = true;
			changedTickers.add(ticker);
			snapshotByTicker[ticker] = {
				holdings: snapshot.holdings,
				sectors: snapshot.sectors,
				error: null,
			};
			continue;
		}

		if (staleSnapshot) {
			snapshotByTicker[ticker] = {
				holdings: staleSnapshot.holdings,
				sectors: staleSnapshot.sectors,
				error: snapshot.error,
			};
		} else {
			snapshotByTicker[ticker] = {
				holdings: [],
				sectors: [],
				error: snapshot.error,
			};
		}
	}

	return {
		stockPositions,
		etfPositions,
		snapshotByTicker,
		etfRefreshedCount,
		cacheChanged,
		changedTickers: [...changedTickers],
	};
}
