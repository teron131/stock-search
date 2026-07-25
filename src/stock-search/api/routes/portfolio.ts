/** Adapts authenticated portfolio HTTP routes to portfolio domain workflows. */

import { Hono } from "hono";
import { z } from "zod";

import { policy } from "../../policy.js";
import {
  buildPortfolioPayload,
  patchPortfolioPosition,
  readStoredPortfolioStatsPayload,
  removePortfolioPosition,
} from "../../portfolio/index.js";
import type { BackendStore } from "../../storage/index.js";
import { normalizeTicker } from "../../utils.js";
import { getCurrentPortfolioKey } from "../auth.js";
import { importPortfolioImage } from "../import-image.js";
import {
  PORTFOLIO,
  PORTFOLIO_IMPORT_IMAGE,
  PORTFOLIO_STATS,
  PORTFOLIO_TICKER_ROUTE,
} from "../route-paths.js";

const PortfolioPositionPatchSchema = z.object({
  quantity: z.number().nullable().optional(),
  strategy: z.string().nullable().optional(),
});
const PortfolioScopeSchema = z
  .enum(policy.request.portfolioScopeValues)
  .catch(policy.request.defaultPortfolioScope);
const PORTFOLIO_STATS_CACHE_CONTROL = "private, max-age=15, stale-while-revalidate=60";

function parseOptionalFormText(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function logPortfolioImageImport(
  level: "info" | "error",
  message: string,
  start: number,
  requestId: string | null,
  fields: Record<string, unknown> = {},
): void {
  const logger = level === "error" ? console.error : console.log;
  logger(
    JSON.stringify({
      level,
      msg: message,
      route: PORTFOLIO_IMPORT_IMAGE,
      requestId,
      ...fields,
      ms: Date.now() - start,
    }),
  );
}

export function createPortfolioRouter(store: BackendStore): Hono {
  const router = new Hono();

  router.get(PORTFOLIO, async (c) => {
    const scope = PortfolioScopeSchema.parse(c.req.query("scope"));
    const portfolioKey = getCurrentPortfolioKey(c);
    c.header("Cache-Control", policy.request.cacheControl(scope));
    return c.json(await buildPortfolioPayload(store, scope, portfolioKey));
  });

  router.get(PORTFOLIO_STATS, async (c) => {
    const portfolioKey = getCurrentPortfolioKey(c);
    c.header("Cache-Control", PORTFOLIO_STATS_CACHE_CONTROL);
    return c.json(await readStoredPortfolioStatsPayload(store, portfolioKey));
  });

  router.patch(PORTFOLIO_TICKER_ROUTE, async (c) => {
    const payload = await c.req.json();
    const parsed = PortfolioPositionPatchSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json({ detail: "Invalid patch payload." }, 400);
    }
    const ticker = c.req.param("ticker");
    if (!normalizeTicker(ticker)) {
      return c.json({ detail: `Invalid ticker: ${ticker}` }, 400);
    }
    try {
      return c.json(
        await patchPortfolioPosition(store, ticker, parsed.data, getCurrentPortfolioKey(c)),
      );
    } catch (error) {
      return c.json({ detail: error instanceof Error ? error.message : "Patch failed" }, 400);
    }
  });

  router.delete(PORTFOLIO_TICKER_ROUTE, async (c) => {
    return c.json(
      await removePortfolioPosition(store, c.req.param("ticker"), getCurrentPortfolioKey(c)),
    );
  });

  router.post(PORTFOLIO_IMPORT_IMAGE, async (c) => {
    const start = Date.now();
    const requestId = c.req.header("x-vercel-id") ?? null;
    c.header("Cache-Control", "no-store");
    const formData = await c.req.raw.formData().catch(() => null);
    if (!formData) {
      logPortfolioImageImport(
        "error",
        "portfolio image import invalid form data",
        start,
        requestId,
      );
      return c.json({ detail: "Invalid upload payload." }, 400);
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      logPortfolioImageImport("error", "portfolio image import missing file", start, requestId);
      return c.json({ detail: "Image file is required." }, 400);
    }

    try {
      logPortfolioImageImport("info", "portfolio image import start", start, requestId, {
        fileType: file.type || null,
        fileSize: file.size,
      });
      const result = await importPortfolioImage(store, {
        file,
        strategy: parseOptionalFormText(formData.get("strategy")),
        model: parseOptionalFormText(formData.get("model")),
        portfolioKey: getCurrentPortfolioKey(c),
      });
      logPortfolioImageImport("info", "portfolio image import done", start, requestId, {
        appliedCount: result.applied_count,
      });
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Portfolio image import failed.";
      logPortfolioImageImport("error", "portfolio image import failed", start, requestId, {
        error: message,
      });
      return c.json({ detail: message }, 400);
    }
  });

  return router;
}
