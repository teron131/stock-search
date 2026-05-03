/** Portfolio API route module. */

import { Hono } from "hono";
import { z } from "zod";
import {
	buildPortfolioPayload,
	cacheControlForScope,
	patchPortfolioPosition,
	removePortfolioPosition,
} from "../../portfolio.js";
import { normalizeTicker } from "../../utils.js";
import type { BackendStore } from "../data-store.js";
import { importPortfolioImage } from "../import-image.js";
import {
	PORTFOLIO,
	PORTFOLIO_IMPORT_IMAGE,
	PORTFOLIO_TICKER_ROUTE,
} from "../route-paths.js";

const PortfolioPositionPatchSchema = z.object({
	quantity: z.number().nullable().optional(),
	strategy: z.string().nullable().optional(),
});
const PortfolioScopeSchema = z
	.enum(["priority", "all_cached", "portfolio_live", "all"])
	.catch("all");

function parseBooleanFormValue(value: FormDataEntryValue | null): boolean {
	const normalized =
		typeof value === "string" ? value.trim().toLowerCase() : "";
	return (
		normalized === "" ||
		normalized === "true" ||
		normalized === "1" ||
		normalized === "yes" ||
		normalized === "on"
	);
}

function parseOptionalFormText(
	value: FormDataEntryValue | null,
): string | null {
	return typeof value === "string" ? value.trim() || null : null;
}

export function createPortfolioRouter(store: BackendStore): Hono {
	const router = new Hono();

	router.get(PORTFOLIO, async (c) => {
		const scope = PortfolioScopeSchema.parse(c.req.query("scope"));
		c.header("Cache-Control", cacheControlForScope(scope));
		return c.json(await buildPortfolioPayload(store, scope));
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
			return c.json(await patchPortfolioPosition(store, ticker, parsed.data));
		} catch (error) {
			return c.json(
				{ detail: error instanceof Error ? error.message : "Patch failed" },
				400,
			);
		}
	});

	router.delete(PORTFOLIO_TICKER_ROUTE, async (c) => {
		return c.json(await removePortfolioPosition(store, c.req.param("ticker")));
	});

	router.post(PORTFOLIO_IMPORT_IMAGE, async (c) => {
		c.header("Cache-Control", "no-store");
		const formData = await c.req.raw.formData().catch(() => null);
		if (!formData) {
			return c.json({ detail: "Invalid upload payload." }, 400);
		}

		const file = formData.get("file");
		if (!(file instanceof File)) {
			return c.json({ detail: "Image file is required." }, 400);
		}

		try {
			return c.json(
				await importPortfolioImage(store, {
					file,
					replace: parseBooleanFormValue(formData.get("replace")),
					strategy: parseOptionalFormText(formData.get("strategy")),
					model: parseOptionalFormText(formData.get("model")),
				}),
			);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Portfolio image import failed.";
			return c.json({ detail: message }, 400);
		}
	});

	return router;
}
