/** Export bundled JSON payloads for the static README demo. */

import path from "node:path";

import { buildColorStandardsPayload } from "./api/color-standards.js";
import { safeFloat } from "./common-utils.js";
import { DATA_SQLITE_PATH, RAW_UI_DIR } from "./config.js";
import { getSectorSnapshot } from "./data-sources/stockanalysis/index.js";
import { normalizeEvaluation } from "./evaluation/normalization.js";
import { writeJson } from "./file-utils.js";
import { getNewsAsync } from "./news/pipeline.js";
import { SQLiteStore } from "./storage/sqlite.js";

const DEMO_OUTPUT_DIR = path.join(RAW_UI_DIR, "public", "demo");
const DEMO_RANDOM_SEED = 20260418;
const DEMO_POSITION_COUNT_RANGE = [14, 20] as const;
const DEMO_BUCKETS = ["Core", "Satellite", "Speculation", "Defense"] as const;
const DEMO_NEWS_MAX_RESULTS = 5;
const DEMO_NEWS_CONCURRENCY = 3;

function weightedAverage(
	rows: Array<Record<string, unknown>>,
	fieldName: string,
): number | null {
	let weightedTotal = 0;
	let weightSum = 0;
	for (const row of rows) {
		const total = safeFloat(row.total);
		const value = safeFloat(row[fieldName]);
		if (total == null || total <= 0 || value == null) {
			continue;
		}
		weightedTotal += total * value;
		weightSum += total;
	}
	return weightSum <= 0 ? null : weightedTotal / weightSum;
}

function createSeededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (1664525 * state + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

function randomInt(
	random: () => number,
	minValue: number,
	maxValue: number,
): number {
	return Math.floor(random() * (maxValue - minValue + 1)) + minValue;
}

function randomChoice<T>(random: () => number, values: readonly T[]): T {
	return values[Math.floor(random() * values.length)];
}

function randomSample<T>(
	random: () => number,
	values: T[],
	count: number,
): T[] {
	const pool = [...values];
	const picked: T[] = [];
	while (pool.length > 0 && picked.length < count) {
		const index = randomInt(random, 0, pool.length - 1);
		picked.push(pool[index]);
		pool.splice(index, 1);
	}
	return picked;
}

function randomQuantity(price: number, random: () => number): number {
	if (price >= 1000) {
		return randomInt(random, 8, 36);
	}
	if (price >= 500) {
		return randomInt(random, 12, 64);
	}
	if (price >= 200) {
		return randomInt(random, 20, 140);
	}
	if (price >= 100) {
		return randomInt(random, 36, 240);
	}
	if (price >= 50) {
		return randomInt(random, 60, 360);
	}
	if (price >= 20) {
		return randomInt(random, 90, 640);
	}
	return randomInt(random, 150, 1200);
}

function pickDemoHoldings(
	stocksMap: Record<
		string,
		{
			indicators: Record<string, unknown>;
			evaluation: Record<string, unknown>;
		}
	>,
	{
		seed,
	}: {
		seed: number;
	},
): Record<string, { quantity: number; strategy: string }> {
	const random = createSeededRandom(seed);
	const candidates: Array<[number, string, number, string | null]> = [];

	for (const [ticker, stockRow] of Object.entries(stocksMap)) {
		const price = safeFloat(stockRow.indicators.price);
		const overallScore = safeFloat(stockRow.evaluation.overall_score);
		if (price == null || price <= 0 || overallScore == null) {
			continue;
		}
		const strategy =
			typeof stockRow.indicators.strategy === "string"
				? stockRow.indicators.strategy.trim()
				: null;
		candidates.push([overallScore, ticker, price, strategy]);
	}

	if (candidates.length === 0) {
		return {};
	}

	candidates.sort((left, right) => right[0] - left[0]);
	const rankedPool = candidates.slice(0, Math.min(candidates.length, 36));
	const targetCount = Math.min(
		rankedPool.length,
		randomInt(
			random,
			DEMO_POSITION_COUNT_RANGE[0],
			DEMO_POSITION_COUNT_RANGE[1],
		),
	);
	const selected = randomSample(random, rankedPool, targetCount);

	const holdings: Record<string, { quantity: number; strategy: string }> = {};
	for (const [, ticker, price, strategy] of selected) {
		holdings[ticker] = {
			quantity: randomQuantity(price, random),
			strategy: strategy ?? randomChoice(random, DEMO_BUCKETS),
		};
	}
	return holdings;
}

function buildDemoRows(
	stocksMap: Record<
		string,
		{
			indicators: Record<string, unknown>;
			evaluation: Record<string, unknown>;
		}
	>,
	{
		generatedAt,
		seed,
	}: {
		generatedAt: string;
		seed: number;
	},
): Record<string, unknown> {
	const holdings = pickDemoHoldings(stocksMap, { seed });
	const rows: Array<Record<string, unknown>> = [];

	for (const ticker of Object.keys(stocksMap).sort()) {
		const stockRow = stocksMap[ticker];
		const indicators = { ...stockRow.indicators };
		const evaluation = normalizeEvaluation(stockRow.evaluation);
		const position = holdings[ticker] ?? {};

		const merged = { ...indicators };
		for (const [key, value] of Object.entries(evaluation)) {
			if (merged[key] == null) {
				merged[key] = value;
			}
		}

		const quantity = Number(position.quantity ?? 0);
		const price = safeFloat(merged.price);
		const total =
			price != null && quantity > 0 ? Number((price * quantity).toFixed(2)) : 0;

		rows.push({
			...merged,
			ticker,
			name:
				typeof merged.name === "string" && merged.name.trim()
					? merged.name
					: ticker,
			quantity,
			total,
			strategy: position.strategy ?? merged.strategy ?? "Speculation",
		});
	}

	const heldRows = rows.filter((row) => {
		const quantity = safeFloat(row.quantity);
		return quantity != null && quantity > 0;
	});
	const totalValue = heldRows.reduce(
		(sum, row) => sum + (safeFloat(row.total) ?? 0),
		0,
	);

	for (const row of rows) {
		const rowTotal = safeFloat(row.total) ?? 0;
		row.weight_pct = totalValue > 0 ? (rowTotal / totalValue) * 100 : 0;
	}

	rows.sort(
		(left, right) =>
			(safeFloat(right.weight_pct) ?? 0) - (safeFloat(left.weight_pct) ?? 0),
	);

	let changeAbsolute = 0;
	for (const row of heldRows) {
		const changePercent = safeFloat(row.change_percent_1d) ?? 0;
		const rowTotal = safeFloat(row.total) ?? 0;
		changeAbsolute +=
			((changePercent / 100) * rowTotal) / (1 + changePercent / 100);
	}

	const priorTotal = totalValue - changeAbsolute;
	const changePercent =
		priorTotal > 0 ? (changeAbsolute / priorTotal) * 100 : 0;
	const weightedBeta = weightedAverage(heldRows, "beta");
	const weightedIv = weightedAverage(heldRows, "iv");

	return {
		rows,
		portfolio_stats: {
			total: Number(totalValue.toFixed(2)),
			change: Number(changeAbsolute.toFixed(2)),
			change_percent: Number(changePercent.toFixed(2)),
			held_positions_count: heldRows.length,
			weighted_beta:
				weightedBeta == null ? null : Number(weightedBeta.toFixed(4)),
			weighted_iv: weightedIv == null ? null : Number(weightedIv.toFixed(4)),
			sector_distribution: [],
		},
		meta: {
			generated_at: generatedAt,
			data_source: "demo",
		},
	};
}

function getDemoNewsTickers(
	portfolioPayload: Record<string, unknown>,
): string[] {
	const rows = Array.isArray(portfolioPayload.rows)
		? (portfolioPayload.rows as Array<Record<string, unknown>>)
		: [];
	const tickers: string[] = [];
	for (const row of rows) {
		const ticker =
			typeof row.ticker === "string" ? row.ticker.trim().toUpperCase() : "";
		const quantity = safeFloat(row.quantity);
		if (!ticker || quantity == null || quantity <= 0) {
			continue;
		}
		tickers.push(ticker);
	}
	return tickers;
}

async function buildSectorsPayload(): Promise<Record<string, unknown>> {
	const snapshot = await getSectorSnapshot();
	const sectors = snapshot.sectors.map((sector) => ({ ...sector }));
	const sectorCount = new Set(
		sectors
			.map((sector) =>
				typeof sector.sector === "string" ? sector.sector.trim() : "",
			)
			.filter(Boolean),
	).size;
	return {
		sectors,
		meta: {
			source: "stockanalysis",
			fetched_at: sectors.length > 0 ? new Date().toISOString() : null,
			sector_count: sectorCount,
		},
	};
}

async function buildNewsPayload(
	tickers: string[],
	{
		generatedAt,
	}: {
		generatedAt: string;
	},
): Promise<Record<string, unknown>> {
	if (tickers.length === 0) {
		return {
			meta: { generated_at: generatedAt },
			items_by_ticker: {},
		};
	}

	const itemsByTicker: Record<string, unknown[]> = {};
	for (let index = 0; index < tickers.length; index += DEMO_NEWS_CONCURRENCY) {
		const batch = tickers.slice(index, index + DEMO_NEWS_CONCURRENCY);
		const results = await Promise.all(
			batch.map(async (ticker) => {
				try {
					return [
						ticker,
						await getNewsAsync(ticker, {
							nDays: 3,
							maxResults: DEMO_NEWS_MAX_RESULTS,
						}),
					] as const;
				} catch {
					return [ticker, [] as unknown[]] as const;
				}
			}),
		);
		for (const [ticker, newsItems] of results) {
			itemsByTicker[ticker] = newsItems;
		}
	}

	return {
		meta: { generated_at: generatedAt },
		items_by_ticker: itemsByTicker,
	};
}

/** Write the static demo JSON payloads used by GitHub Pages. */
export async function writeStaticDemoSnapshot({
	stocksMap,
	generatedAt,
	outputDir = DEMO_OUTPUT_DIR,
	seed = DEMO_RANDOM_SEED,
}: {
	stocksMap?: Record<
		string,
		{
			indicators: Record<string, unknown>;
			evaluation: Record<string, unknown>;
		}
	>;
	generatedAt?: string;
	outputDir?: string;
	seed?: number;
} = {}): Promise<Record<string, string>> {
	const resolvedGeneratedAt = generatedAt ?? new Date().toISOString();
	const store = new SQLiteStore(DATA_SQLITE_PATH);
	const loadedStocksMap = await store.loadStocks();
	const resolvedStocksMap =
		stocksMap ??
		Object.fromEntries(
			Object.entries(loadedStocksMap).map(([ticker, row]) => [
				ticker,
				{
					indicators: row.indicators,
					evaluation: row.evaluation,
				},
			]),
		);

	const portfolioPayload = buildDemoRows(resolvedStocksMap, {
		generatedAt: resolvedGeneratedAt,
		seed,
	});
	const demoNewsTickers = getDemoNewsTickers(portfolioPayload);

	const writtenPaths = {
		portfolio: path.join(outputDir, "portfolio.json"),
		color_standards: path.join(outputDir, "color-standards.json"),
		sectors: path.join(outputDir, "sectors.json"),
		news: path.join(outputDir, "news.json"),
	};

	await writeJson(writtenPaths.portfolio, portfolioPayload);
	await writeJson(writtenPaths.color_standards, buildColorStandardsPayload());

	const [sectorsPayload, newsPayload] = await Promise.all([
		buildSectorsPayload(),
		buildNewsPayload(demoNewsTickers, {
			generatedAt: resolvedGeneratedAt,
		}),
	]);
	await writeJson(writtenPaths.sectors, sectorsPayload);
	await writeJson(writtenPaths.news, newsPayload);

	return writtenPaths;
}

async function main(): Promise<void> {
	const paths = await writeStaticDemoSnapshot();
	for (const [name, filePath] of Object.entries(paths)) {
		console.log(`${name}: ${filePath}`);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
