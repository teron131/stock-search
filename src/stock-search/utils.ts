import { ROOT } from "./api/route-paths.js";

export function nowIso(date = new Date()): string {
	return date.toISOString();
}

export function normalizeTicker(value: unknown): string {
	return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function uniqueTickers(values: Iterable<string>): string[] {
	const normalized = [...values]
		.map((value) => normalizeTicker(value))
		.filter(Boolean);
	return [...new Set(normalized)];
}

export function asRecord(
	value: unknown,
): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function asNumber(value: unknown): number | null {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

export function extractDomain(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return "";
	}
}

export function sanitizeNextPath(value: string | null | undefined): string {
	const candidate = String(value ?? "").trim();
	if (!candidate.startsWith("/") || candidate.startsWith("//")) {
		return ROOT;
	}
	return candidate;
}
