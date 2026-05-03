/** Import the local SQLite data store into the Convex backend. */

import { config as loadDotenv } from "dotenv";

import { DATA_SQLITE_PATH } from "../../config.js";
import { SQLiteStore } from "../../sqlite-store.js";
import { ConvexHttpClient } from "./client.js";
import {
	normalizePortfolioPositions,
	stockMapToRows,
} from "./convex-schemas.js";
import {
	CONVEX_META_SET,
	CONVEX_PORTFOLIO_SET,
	CONVEX_SECTORS_SET,
	CONVEX_STOCK_REPLACE_ALL,
} from "./function-names.js";

const STATS_GENERATED_AT_KEY = "stats_generated_at";

/** Push the local portfolio and stock data store into Convex. */
export async function runImportFromLocalStore({
	dbPath = DATA_SQLITE_PATH,
}: {
	dbPath?: string;
} = {}): Promise<{ positions: number; stocks: number; sectors: number }> {
	const client = new ConvexHttpClient(
		process.env.CONVEX_URL ?? "",
		process.env.CONVEX_DEPLOY_KEY ?? "",
	);
	const store = new SQLiteStore(dbPath);
	const [positions, mergedStockMap, sectorSnapshot] = await Promise.all([
		store.loadPositions().then(normalizePortfolioPositions),
		store.loadStocks(),
		store.loadSectorSnapshot(),
	]);

	const mutations: Array<Promise<unknown>> = [
		client.mutation(CONVEX_PORTFOLIO_SET, {
			key: "default",
			positions,
		}),
		client.mutation(CONVEX_STOCK_REPLACE_ALL, {
			rows: stockMapToRows(
				Object.fromEntries(
					Object.entries(mergedStockMap).map(([ticker, row]) => [
						ticker,
						{
							indicators: row.indicators,
							evaluation: row.evaluation,
							labels: row.labels,
						},
					]),
				),
			),
		}),
		client.mutation(CONVEX_META_SET, {
			key: STATS_GENERATED_AT_KEY,
			value: new Date().toISOString(),
		}),
	];

	if (sectorSnapshot && sectorSnapshot.sectors.length > 0) {
		mutations.push(
			client.mutation(CONVEX_SECTORS_SET, {
				key: "default",
				sectors: sectorSnapshot.sectors,
				meta: sectorSnapshot.meta,
			}),
		);
	}

	await Promise.all(mutations);

	return {
		positions: positions.length,
		stocks: Object.keys(mergedStockMap).length,
		sectors: sectorSnapshot?.sectors.length ?? 0,
	};
}

/** Deprecated compatibility wrapper for the old JSON import entrypoint. */
export async function runImportFromLocalFiles({
	dbPath = DATA_SQLITE_PATH,
	portfolioPath,
	statsPath,
	evalPath,
}: {
	dbPath?: string;
	portfolioPath?: string | null;
	statsPath?: string | null;
	evalPath?: string | null;
} = {}): Promise<{ positions: number; stocks: number; sectors: number }> {
	if (portfolioPath != null || statsPath != null || evalPath != null) {
		throw new Error(
			"JSON-based import arguments were removed. Use dbPath or runImportFromLocalStore() with the local SQLite database instead.",
		);
	}
	return runImportFromLocalStore({ dbPath });
}

async function main(): Promise<void> {
	loadDotenv({ path: ".env" });
	console.log(await runImportFromLocalStore());
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
