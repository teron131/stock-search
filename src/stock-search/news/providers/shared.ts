/** Shared news provider parsing helpers. */

export const DAY_IN_MS = 24 * 60 * 60 * 1000;
export const NEWS_PROVIDER_MAX_RESULTS = 10;
const DEFAULT_USER_AGENT = "Mozilla/5.0";

type JsonResponseLike = {
	json(): Promise<unknown> | unknown;
	ok?: boolean;
	status?: number;
	raise_for_status?: () => void;
};

export function normalizeDomain(rawUrl: string): string | null {
	try {
		return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return null;
	}
}

export function parseDate(value: unknown): Date | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		const timestamp = value < 1e12 ? value * 1000 : value;
		return new Date(timestamp);
	}
	if (typeof value !== "string" || !value.trim()) {
		return null;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

export function parseDateString(
	rawDate: string | null | undefined,
): Date | null {
	return parseDate(rawDate);
}

export function formatDate(date: Date | null): string | null {
	if (!date) {
		return null;
	}
	return date.toISOString().slice(0, 10);
}

export function daysAgo(date: Date | null): number | null {
	if (!date) {
		return null;
	}
	return Math.max(0, Math.floor((Date.now() - date.getTime()) / DAY_IN_MS));
}

function withDefaultHeaders(init: RequestInit = {}): RequestInit {
	const headers = new Headers(init.headers);
	if (!headers.has("user-agent")) {
		headers.set("user-agent", DEFAULT_USER_AGENT);
	}
	return {
		...init,
		headers,
	};
}

export async function readJsonResponse<T>(
	response: JsonResponseLike,
): Promise<T> {
	response.raise_for_status?.();
	if (response.ok === false) {
		throw new Error(`HTTP ${response.status ?? "request_failed"}`);
	}
	return (await response.json()) as T;
}

export async function fetchJson<T>(
	url: string,
	init?: RequestInit,
): Promise<T | null> {
	try {
		const response = await fetch(url, withDefaultHeaders(init));
		if (!response.ok) {
			return null;
		}
		return (await response.json()) as T;
	} catch {
		return null;
	}
}
