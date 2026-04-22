/** Portfolio API route module. */

import { z } from "zod";
import { Hono } from "hono";

import type { BackendStore } from "../data-store.js";
import { normalizeTicker } from "../../utils.js";
import { importPortfolioImage } from "../import-image.js";
import {
	buildPortfolioPayload,
	cacheControlForScope,
	patchPortfolioPosition,
	removePortfolioPosition,
} from "../../portfolio.js";
import { PORTFOLIO, PORTFOLIO_IMPORT_IMAGE, PORTFOLIO_TICKER } from "../route-paths.js";

const portfolioPositionPatchSchema = z.object({
	quantity: z.number().optional(),
	strategy: z.string().nullable().optional(),
});

export function createPortfolioRouter(store: BackendStore): Hono {
	const router = new Hono();

	router.get(PORTFOLIO, async (c) => {
		const requestedScope = c.req.query("scope");
		const scope =
			requestedScope === "priority" ||
			requestedScope === "all_cached" ||
			requestedScope === "portfolio_live" ||
			requestedScope === "all"
				? requestedScope
				: "all";
		c.header("Cache-Control", cacheControlForScope(scope));
		return c.json(await buildPortfolioPayload(store, scope));
	});

	router.patch(PORTFOLIO_TICKER, async (c) => {
		const payload = await c.req.json();
		const parsed = portfolioPositionPatchSchema.safeParse(payload);
		if (!parsed.success) {
			return c.json({ detail: "Invalid patch payload." }, 400);
		}
		const ticker = c.req.param("ticker");
		if (!normalizeTicker(ticker)) {
			return c.json({ detail: `Invalid ticker: ${ticker}` }, 400);
		}
		try {
			return c.json(await patchPortfolioPosition(store, ticker, parsed.data));
		} catch (error) {
			return c.json(
				{ detail: error instanceof Error ? error.message : "Patch failed" },
				400,
			);
		}
	});

	router.delete(PORTFOLIO_TICKER, async (c) => {
		return c.json(await removePortfolioPosition(store, c.req.param("ticker")));
	});

	router.post(PORTFOLIO_IMPORT_IMAGE, (c) =>
		c.req.raw
			.formData()
			.then(async (formData) => {
				c.header("Cache-Control", "no-store");
				const file = formData.get("file");
				if (!(file instanceof File)) {
					return c.json({ detail: "Image file is required." }, 400);
				}
				try {
					const replaceValue = String(formData.get("replace") ?? "true")
						.trim()
						.toLowerCase();
					return c.json(
						await importPortfolioImage(store, {
							file,
							replace:
								replaceValue === "" ||
								replaceValue === "true" ||
								replaceValue === "1" ||
								replaceValue === "yes" ||
								replaceValue === "on",
							strategy:
								typeof formData.get("strategy") === "string"
									? String(formData.get("strategy")).trim() || null
									: null,
							model:
								typeof formData.get("model") === "string"
									? String(formData.get("model")).trim() || null
									: null,
						}),
					);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "Portfolio image import failed.";
					return c.json({ detail: message }, 400);
				}
			})
			.catch(() => c.json({ detail: "Invalid upload payload." }, 400)),
	);

	return router;
}
