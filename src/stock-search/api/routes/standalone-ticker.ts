/** Standalone ticker API route module. */

import { Hono } from "hono";

import { normalizeTicker } from "../../utils.js";
import type { BackendStore } from "../data-store.js";
import {
	buildEvaluateTickerPayload,
	buildStandaloneTickerPayload,
} from "../ticker-standalone.js";
import { STOCK_EVALUATE, STOCK_STATS } from "../route-paths.js";

export function createStandaloneTickerRouter(store: BackendStore): Hono {
	const router = new Hono();

	router.get(STOCK_EVALUATE, async (c) => {
		const ticker = c.req.param("ticker");
		try {
			return c.json(await buildEvaluateTickerPayload(store, ticker));
		} catch (error) {
			return c.json(
				{ detail: error instanceof Error ? error.message : "Unknown error" },
				404,
			);
		}
	});

	router.get(STOCK_STATS, async (c) => {
		c.header("Cache-Control", "no-store");
		const source = c.req.query("source");
		const resolvedSource =
			source === "auto" || source === "live" || source === "cache"
				? source
				: "auto";
		try {
			return c.json(
				await buildStandaloneTickerPayload(store, c.req.param("ticker"), resolvedSource),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			if (message.includes("Live stats unavailable")) {
				return c.json(
					{
						detail: `Live stats unavailable for ticker: ${normalizeTicker(c.req.param("ticker"))}`,
					},
					502,
				);
			}
			if (message.includes("Invalid ticker")) {
				return c.json({ detail: `Invalid ticker: ${c.req.param("ticker")}` }, 400);
			}
			return c.json({ detail: message }, 404);
		}
	});

	return router;
}
