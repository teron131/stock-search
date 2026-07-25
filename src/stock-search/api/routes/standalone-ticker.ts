/** Adapts standalone ticker stats and evaluation HTTP routes to ticker workflows. */

import { Hono } from "hono";

import { policy } from "../../policy.js";
import { isLiveStatsUnavailableError } from "../../stats-resolver/index.js";
import type { BackendStore } from "../../storage/index.js";
import {
  buildEvaluateTickerPayload,
  buildStandaloneTickerPayload,
  InvalidTickerError,
} from "../../ticker.js";
import { getCurrentPortfolioKey } from "../auth.js";
import { STOCK_EVALUATE_ROUTE, STOCK_STATS_ROUTE } from "../route-paths.js";

export function createStandaloneTickerRouter(store: BackendStore): Hono {
  const router = new Hono();

  router.get(STOCK_EVALUATE_ROUTE, async (c) => {
    const ticker = c.req.param("ticker");
    try {
      return c.json(await buildEvaluateTickerPayload(store, ticker, getCurrentPortfolioKey(c)));
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Unknown error" }, 404);
    }
  });

  router.get(STOCK_STATS_ROUTE, async (c) => {
    c.header("Cache-Control", "no-store");
    const source = c.req.query("source");
    const resolvedSource = policy.request.tickerSource(source);
    try {
      return c.json(
        await buildStandaloneTickerPayload(
          store,
          c.req.param("ticker"),
          resolvedSource,
          getCurrentPortfolioKey(c),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (isLiveStatsUnavailableError(error)) {
        return c.json({ detail: error.message }, 502);
      }
      if (error instanceof InvalidTickerError) {
        return c.json({ detail: error.message }, 400);
      }
      return c.json({ detail: message }, 404);
    }
  });

  return router;
}
