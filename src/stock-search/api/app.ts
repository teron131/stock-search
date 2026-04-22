/** Main API app composition for the mirrored stock-search TypeScript backend. */

import { readFile } from "node:fs/promises";

import { Hono } from "hono";

import { appConfig } from "./config.js";
import { authGuard } from "./auth.js";
import { getStore, type BackendStore } from "./data-store.js";
import { createAuthRouter } from "./routes/auth.js";
import { createMiscRouter } from "./routes/misc.js";
import { createPortfolioRouter } from "./routes/portfolio.js";
import { createStandaloneTickerRouter } from "./routes/standalone-ticker.js";
import {
	CALENDAR,
	DASHBOARD,
	DASHBOARD_PAGE_PATHS,
	INDUSTRY,
	MARKETMAP,
	ROOT,
} from "./route-paths.js";

export type AppDependencies = {
	store: BackendStore;
	indexFile: string;
	clock: () => Date;
};

async function serveIndex(indexFile: string): Promise<Response> {
	const html = await readFile(indexFile, "utf8");
	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
		},
	});
}

export function createApp(overrides: Partial<AppDependencies> = {}): Hono {
	const deps: AppDependencies = {
		store: overrides.store ?? getStore(),
		indexFile: overrides.indexFile ?? appConfig.indexFile,
		clock: overrides.clock ?? (() => new Date()),
	};
	void deps.clock;

	const app = new Hono();
	app.use("*", authGuard);

	for (const pagePath of DASHBOARD_PAGE_PATHS) {
		app.get(pagePath, async () => serveIndex(deps.indexFile));
	}
	app.get(ROOT, async () => serveIndex(deps.indexFile));
	app.get(DASHBOARD, async () => serveIndex(deps.indexFile));
	app.get(INDUSTRY, async () => serveIndex(deps.indexFile));
	app.get(MARKETMAP, async () => serveIndex(deps.indexFile));
	app.get(CALENDAR, async () => serveIndex(deps.indexFile));

	app.route("/", createAuthRouter());
	app.route("/", createPortfolioRouter(deps.store));
	app.route("/", createStandaloneTickerRouter(deps.store));
	app.route("/", createMiscRouter(deps.store));

	app.notFound((c) => c.json({ detail: "Not found" }, 404));
	return app;
}

const app = createApp();
export default app;
