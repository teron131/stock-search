/** Loads environment-backed backend and UI runtime configuration. */

import { existsSync } from "node:fs";
import path from "node:path";

import { config as loadDotenv } from "dotenv";

import type { BackendName } from "../storage/index.js";

loadDotenv({ quiet: true });

const repoRoot = process.cwd();
const rawUiDir = path.join(repoRoot, "ui");
const outUiDir = path.join(rawUiDir, "out");
const distUiDir = path.join(rawUiDir, "dist");

export function getUiDir(uiRoot = rawUiDir): string {
  for (const buildDirName of ["out", "dist"]) {
    const buildDir = path.join(uiRoot, buildDirName);
    if (existsSync(path.join(buildDir, "index.html"))) {
      return buildDir;
    }
  }
  return uiRoot;
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
  return value?.trim().toLowerCase() === "d1" ? "d1" : "sqlite";
}

export const appConfig = {
  repoRoot,
  rawUiDir,
  outUiDir,
  distUiDir,
  uiDir: getUiDir(rawUiDir),
  indexFile: getIndexFile(rawUiDir),
  isVercelRuntime: truthy(process.env.VERCEL) || Boolean(process.env.VERCEL_ENV),
  dataSqlitePath: path.resolve(
    process.env.DATA_SQLITE_PATH ?? path.join(dataDir, "stock_search.db"),
  ),
  dataStoreBackend: resolveBackend(process.env.DATA_STORE_BACKEND),
  d1AccountId: (process.env.D1_ACCOUNT_ID ?? "").trim(),
  d1DatabaseId: (process.env.D1_DATABASE_ID ?? "").trim(),
  d1ApiToken: (process.env.D1_API_TOKEN ?? "").trim(),
  authEnabled: truthy(process.env.AUTH_ENABLED, false),
  authSecret: (process.env.AUTH_SECRET ?? "").trim(),
  authGoogleId: (process.env.AUTH_GOOGLE_ID ?? "").trim(),
  authGoogleSecret: (process.env.AUTH_GOOGLE_SECRET ?? "").trim(),
  allowedEmail: (process.env.ALLOWED_EMAIL ?? "").trim().toLowerCase(),
  nodeHost: (process.env.BACKEND_HOST ?? "localhost").trim() || "localhost",
  nodePort: Number(process.env.PORT ?? 8000),
};
