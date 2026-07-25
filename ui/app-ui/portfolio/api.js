import { CONFIG } from "../config.js";
import { normalizeApiDashboardPayload } from "../dataContract.js";

export const LOADING_MODE_IDLE = "idle";
export const LOADING_MODE_FOREGROUND = "foreground";
export const LOADING_MODE_BACKGROUND = "background";

export async function tryFetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchJsonWithTimeout(url, timeoutMs, signal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const res = await fetch(url, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    signal?.removeEventListener("abort", abortFromParent);
    clearTimeout(timeoutId);
  }
}

export function getPortfolioUrl(scope) {
  if (CONFIG.isDemoMode) {
    return CONFIG.demoEndpoints.portfolio;
  }

  if (!scope) {
    return CONFIG.endpoints.portfolio;
  }

  return `${CONFIG.endpoints.portfolio}?scope=${encodeURIComponent(scope)}`;
}

export async function readPortfolioPayload({
  background = false,
  colorStandards,
  scope,
  signal,
} = {}) {
  const shouldFetchMetadata = !background;
  const timeoutMs = background
    ? CONFIG.requestTimeoutMs.portfolioBackground
    : CONFIG.requestTimeoutMs.portfolioForeground;
  const portfolioUrl = getPortfolioUrl(scope);
  const standardsUrl = CONFIG.isDemoMode
    ? CONFIG.demoEndpoints.colorStandards
    : CONFIG.endpoints.colorStandards;
  const standardsPromise =
    shouldFetchMetadata && !colorStandards
      ? fetchJsonWithTimeout(standardsUrl, timeoutMs, signal)
      : Promise.resolve(null);
  const rawPayload = await fetchJsonWithTimeout(portfolioUrl, timeoutMs, signal);
  const dashData = normalizeApiDashboardPayload(rawPayload);
  if (!dashData) {
    throw new Error("API Failure");
  }

  const standardsPayload = await standardsPromise;
  const standards = standardsPayload?.standards;
  return {
    dashData,
    standards: standards && typeof standards === "object" ? standards : null,
    isDemoData: CONFIG.isDemoMode,
  };
}

export function getLoadingMode(background) {
  return background ? LOADING_MODE_BACKGROUND : LOADING_MODE_FOREGROUND;
}

export function normalizeQuantityInput(quantity) {
  if (quantity == null || String(quantity).trim() === "") {
    return 0;
  }
  const normalizedQuantity = Number(quantity);
  return Number.isFinite(normalizedQuantity) ? normalizedQuantity : null;
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}
