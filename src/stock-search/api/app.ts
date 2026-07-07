/** Main API app composition for the stock-search TypeScript backend. */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { Hono } from "hono";
import { getSectorSnapshot } from "../data-sources/stockanalysis/index.js";
import type { BackendStore } from "../storage/index.js";
import { createLazyStore } from "../storage/startup.js";
import { authGuard } from "./auth.js";
import { appConfig } from "./config.js";
import {
	APP_PAGE_PATHS,
	normalizeAppPagePath,
	ROOT,
	SECTORS,
} from "./route-paths.js";
import { createAuthRouter } from "./routes/auth.js";
import { createMiscRouter } from "./routes/misc.js";
import { createNewsRouter } from "./routes/news.js";
import { createPortfolioRouter } from "./routes/portfolio.js";
import { createStandaloneTickerRouter } from "./routes/standalone-ticker.js";

export type AppDependencies = {
	store: BackendStore;
	indexFile: string;
};

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

function pageHtmlFile(indexFile: string, pathname: string): string {
	const pagePath = normalizeAppPagePath(pathname);
	if (!pagePath || pagePath === ROOT) {
		return indexFile;
	}
	return path.join(path.dirname(indexFile), pagePath.slice(1), "index.html");
}

async function readPageHtml(
	indexFile: string,
	pathname: string,
): Promise<string> {
	const selectedIndexFile = pageHtmlFile(indexFile, pathname);
	try {
		return await readFile(selectedIndexFile, "utf8");
	} catch (error) {
		if (selectedIndexFile !== indexFile && isMissingFileError(error)) {
			return readFile(indexFile, "utf8");
		}
		throw error;
	}
}

async function servePage(
	indexFile: string,
	pathname: string,
): Promise<Response> {
	return new Response(await readPageHtml(indexFile, pathname), {
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

/** Compose the Hono app with injectable store/index dependencies for tests and runtimes. */
export function createApp(overrides: Partial<AppDependencies> = {}): Hono {
	const deps: AppDependencies = {
		store: overrides.store ?? createLazyStore(),
		indexFile: overrides.indexFile ?? appConfig.indexFile,
	};

	const app = new Hono();
	app.use("*", authGuard);

	const pageRoutePaths = (pagePath: string) =>
		pagePath === ROOT ? [ROOT] : [pagePath, `${pagePath}/`];

	for (const pagePath of APP_PAGE_PATHS) {
		if (pagePath === SECTORS) {
			continue;
		}
		for (const routePath of pageRoutePaths(pagePath)) {
			app.get(routePath, async (c) => servePage(deps.indexFile, c.req.path));
		}
	}
	for (const routePath of pageRoutePaths(SECTORS)) {
		app.get(routePath, async (c) => {
			if (isPageNavigation(c.req.raw)) {
				return servePage(deps.indexFile, c.req.path);
			}
			c.header("Cache-Control", "no-store");
			return c.json(await getSectorSnapshot(deps.store));
		});
	}
	app.route("/", createAuthRouter());
	app.route("/", createPortfolioRouter(deps.store));
	app.route("/", createStandaloneTickerRouter(deps.store));
	app.route("/", createNewsRouter(deps.store));
	app.route("/", createMiscRouter(deps.store));

	app.notFound((c) => c.json({ detail: "Not found" }, 404));
	return app;
}

const app = createApp();
export default app;
