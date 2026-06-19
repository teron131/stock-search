/** Main API app composition for the stock-search TypeScript backend. */

import { readFile } from "node:fs/promises";

import { Hono } from "hono";
import { getSectorSnapshot } from "../data-sources/stockanalysis/index.js";
import { type BackendStore, createLazyStore } from "../storage/index.js";
import { authGuard } from "./auth.js";
import { appConfig } from "./config.js";
import {
	CALENDAR,
	DASHBOARD,
	DASHBOARD_PAGE_PATHS,
	MARKETMAP,
	ROOT,
	SECTORS,
} from "./route-paths.js";
import { createAuthRouter } from "./routes/auth.js";
import { createMiscRouter } from "./routes/misc.js";
import { createPortfolioRouter } from "./routes/portfolio.js";
import { createStandaloneTickerRouter } from "./routes/standalone-ticker.js";

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

function isPageNavigation(request: Request): boolean {
	const destination = request.headers.get("sec-fetch-dest");
	if (destination === "document") {
		return true;
	}

	const accept = request.headers.get("accept") ?? "";
	return accept.includes("text/html") && !accept.includes("application/json");
}

export function createApp(overrides: Partial<AppDependencies> = {}): Hono {
	const deps: AppDependencies = {
		store: overrides.store ?? createLazyStore(),
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
	app.get(SECTORS, async (c) => {
		if (isPageNavigation(c.req.raw)) {
			return serveIndex(deps.indexFile);
		}
		c.header("Cache-Control", "no-store");
		return c.json(await getSectorSnapshot(deps.store));
	});
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
