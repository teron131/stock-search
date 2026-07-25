/** Own portfolio storage key construction shared by SQLite and D1 backends. */

import { createHash } from "node:crypto";

import { DEFAULT_STORAGE_KEY } from "./schemas.js";

export const PORTFOLIO_STATS_GENERATED_AT_META_KEY = "portfolio_stats_generated_at";

function normalizePortfolioKey(key?: string): string {
  return String(key ?? "").trim() || DEFAULT_STORAGE_KEY;
}

export function portfolioKeyForGoogleSubject(googleSubject: string): string {
  const subject = googleSubject.trim();
  if (!subject) {
    return DEFAULT_STORAGE_KEY;
  }
  const subjectHash = createHash("sha256").update(subject).digest("base64url");
  return `google:${subjectHash}`;
}

export function portfolioScopedMetaKey(baseKey: string, portfolioKey?: string): string {
  const key = normalizePortfolioKey(portfolioKey);
  return key === DEFAULT_STORAGE_KEY ? baseKey : `${baseKey}:${key}`;
}
