/** Shared news provider parsing helpers. */

export const DAY_IN_MS = 24 * 60 * 60 * 1000;

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

export function parseDateString(rawDate: string | null | undefined): Date | null {
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

export async function fetchJson(url: string): Promise<unknown | null> {
	try {
		const response = await fetch(url, {
			headers: {
				"user-agent": "Mozilla/5.0",
			},
		});
		if (!response.ok) {
			return null;
		}
		return await response.json();
	} catch {
		return null;
	}
}
