/** Create and verify the configured backend store at runtime startup. */

import { appConfig } from "../api/config.js";
import { setCalibrationStatsRows } from "../evaluation/anchors.js";
import { queueEvaluationCalibrationRowsSync } from "../evaluation/calibration-db.js";
import { D1Store } from "./d1.js";
import type { BackendStore } from "./index.js";
import { SQLiteStore } from "./sqlite.js";

let cachedStore: BackendStore | null = null;

/** Queue calibration sync for stock rows written through the lazy startup store. */
async function queueCalibrationSyncForRows(
	store: BackendStore,
	rows: Parameters<BackendStore["upsertStocks"]>[0],
): Promise<void> {
	const stocks = await store.loadStocksByTickers(rows.map((row) => row.ticker));
	queueEvaluationCalibrationRowsSync(
		Object.entries(stocks).map(([ticker, stock]) => ({
			ticker,
			indicators: stock.indicators,
			evaluation: stock.evaluation,
			labels: stock.labels,
		})),
		{ store },
	);
}

/** Resolve one lazy-store property from the configured concrete store. */
function lazyStoreProperty(property: string | symbol): unknown {
	if (property === "then") {
		return undefined;
	}
	if (property === "upsertStocks") {
		return async (rows: Parameters<BackendStore["upsertStocks"]>[0]) => {
			const store = getStore();
			await store.upsertStocks(rows);
			await queueCalibrationSyncForRows(store, rows);
		};
	}

	const store = getStore();
	const value = store[property as keyof BackendStore];
	return typeof value === "function" ? value.bind(store) : value;
}

/** Create a lazy store adapter for app composition before startup config is touched. */
export function createLazyStore(): BackendStore {
	return new Proxy({} as BackendStore, {
		get(_target, property) {
			return lazyStoreProperty(property);
		},
	});
}

/** Create the configured concrete backend store. */
export function createStore(): BackendStore {
	if (appConfig.dataStoreBackend === "d1") {
		return new D1Store(
			appConfig.d1AccountId,
			appConfig.d1DatabaseId,
			appConfig.d1ApiToken,
		);
	}
	return new SQLiteStore(appConfig.dataSqlitePath);
}

/** Return the process-wide backend store instance. */
export function getStore(): BackendStore {
	cachedStore ??= createStore();
	return cachedStore;
}

/** Verify startup connectivity and seed calibration data from storage. */
export async function verifyStoreStartup(
	store: BackendStore = getStore(),
): Promise<void> {
	if (appConfig.dataStoreBackend === "d1") {
		await store.getMetaValue("stats_generated_at");
	}
	setCalibrationStatsRows(await store.loadCalibrationStats());
}
