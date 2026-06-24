/** Miscellaneous API route module. */

import { Hono } from "hono";
import { runCorrelationReport } from "../../correlation.js";
import { loadEvalMap, loadStocksMap } from "../../portfolio/index.js";
import type { BackendStore } from "../../storage/index.js";
import { normalizeTicker } from "../../utils.js";
import { buildColorStandardsPayload } from "../color-standards.js";
import {
	COLOR_STANDARDS,
	EVAL,
	PORTFOLIO_CORRELATION,
	REALTIME_CONFIG,
	STOCKS,
} from "../route-paths.js";

const CORRELATION_MODES = new Set(["raw", "market_neutral"]);

/** Parse comma-separated ticker query values for read-only utility routes. */
function parseTickersQuery(rawValue: string | undefined): string[] | undefined {
	if (typeof rawValue !== "string" || !rawValue.trim()) {
		return undefined;
	}

	const tickers = [
		...new Set(
			rawValue
				.split(",")
				.map((ticker) => normalizeTicker(ticker))
				.filter(Boolean),
		),
	];
	return tickers.length > 0 ? tickers : undefined;
}

/** Parse correlation mode query values with the raw mode default. */
function parseCorrelationMode(
	rawValue: string | undefined,
): "raw" | "market_neutral" {
	const mode = String(rawValue || "raw").trim();
	return CORRELATION_MODES.has(mode)
		? (mode as "raw" | "market_neutral")
		: "raw";
}

/** Create miscellaneous utility routes that do not own portfolio or news writes. */
export function createMiscRouter(store: BackendStore): Hono {
	const router = new Hono();

	router.get(STOCKS, async (c) => {
		c.header("Cache-Control", "no-store");
		return c.json(
			await loadStocksMap(store, parseTickersQuery(c.req.query("tickers"))),
		);
	});

	router.get(EVAL, async (c) => {
		c.header("Cache-Control", "no-store");
		return c.json(
			await loadEvalMap(store, parseTickersQuery(c.req.query("tickers"))),
		);
	});

	router.get(PORTFOLIO_CORRELATION, async (c) => {
		c.header("Cache-Control", "no-store");
		return c.json(
			await runCorrelationReport({
				tickers: parseTickersQuery(c.req.query("tickers")),
				correlationMode: parseCorrelationMode(c.req.query("mode")),
			}),
		);
	});

	router.get(COLOR_STANDARDS, (c) => {
		c.header(
			"Cache-Control",
			"public, max-age=3600, stale-while-revalidate=86400",
		);
		return c.json(buildColorStandardsPayload());
	});

	router.get(REALTIME_CONFIG, (c) => {
		c.header("Cache-Control", "no-store");
		return c.json({
			provider: "none",
			enabled: false,
			topics: [],
		});
	});

	return router;
}
