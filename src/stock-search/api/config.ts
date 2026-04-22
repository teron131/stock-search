import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";

loadDotenv();

export type BackendName = "convex" | "sqlite";

const repoRoot = process.cwd();
const rawUiDir = path.join(repoRoot, "ui");
const distUiDir = path.join(rawUiDir, "dist");

export function getUiDir(uiRoot = rawUiDir): string {
	const distDir = path.join(uiRoot, "dist");
	const distIndex = path.join(distDir, "index.html");
	return existsSync(distIndex) ? distDir : uiRoot;
}

export function getIndexFile(uiRoot = rawUiDir): string {
	return path.join(getUiDir(uiRoot), "index.html");
}

const dataDir = path.join(repoRoot, "data");

function truthy(value: string | undefined, fallback = false): boolean {
	if (value == null || value === "") {
		return fallback;
	}
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function resolveBackend(value: string | undefined): BackendName {
	return value?.trim().toLowerCase() === "convex" ? "convex" : "sqlite";
}

export const appConfig = {
	repoRoot,
	rawUiDir,
	distUiDir,
	uiDir: getUiDir(rawUiDir),
	indexFile: getIndexFile(rawUiDir),
	dataSqlitePath: path.resolve(
		process.env.DATA_SQLITE_PATH ?? path.join(dataDir, "stock_search.db"),
	),
	dataStoreBackend: resolveBackend(process.env.DATA_STORE_BACKEND),
	convexUrl: (process.env.CONVEX_URL ?? "").trim(),
	convexDeployKey: (process.env.CONVEX_DEPLOY_KEY ?? "").trim(),
	convexAudience: (process.env.CONVEX_AUDIENCE ?? "").trim(),
	convexSyncEnabled: truthy(process.env.CONVEX_SYNC_ENABLED, true),
	authEnabled: truthy(process.env.AUTH_ENABLED, false),
	authSecret:
		(process.env.AUTH_SECRET ?? "").trim() || "stock-search-auth-disabled",
	authGoogleId: (process.env.AUTH_GOOGLE_ID ?? "").trim(),
	authGoogleSecret: (process.env.AUTH_GOOGLE_SECRET ?? "").trim(),
	allowedEmail: (process.env.ALLOWED_EMAIL ?? "").trim().toLowerCase(),
	nodeHost: (process.env.BACKEND_HOST ?? "localhost").trim() || "localhost",
	nodePort: Number(process.env.PORT ?? 8000),
};
