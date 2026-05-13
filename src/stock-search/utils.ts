import { ROOT } from "./api/route-paths.js";

const CANONICAL_TICKERS: Record<string, string> = {
	"KRX:000660": "000660.KS",
	"KRX:005930": "005930.KS",
};

export function nowIso(date = new Date()): string {
	return date.toISOString();
}

export function normalizeTicker(value: unknown): string {
	if (typeof value !== "string") {
		return "";
	}
	const ticker = value
		.trim()
		.toUpperCase()
		.replace(/\s*:\s*/g, ":")
		.replace(/^([A-Z0-9]{1,8})\s+([A-Z]{2,4})$/, "$1.$2");
	const krxMatch = ticker.match(/^KRX:(\d{6})$/);
	return CANONICAL_TICKERS[ticker] ?? (krxMatch ? `${krxMatch[1]}.KS` : ticker);
}

export function uniqueTickers(values: Iterable<string>): string[] {
	const normalized = [...values]
		.map((value) => normalizeTicker(value))
		.filter(Boolean);
	return [...new Set(normalized)];
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function asNumber(value: unknown): number | null {
	if (value == null) {
		return null;
	}
	if (typeof value === "string") {
		const normalized = value
			.trim()
			.toUpperCase()
			.replace(/^[A-Z]{3}\s+/, "")
			.replace(/^\$/, "")
			.replace(/,/g, "");
		const match = normalized.match(/^(-?\d+(?:\.\d+)?)([TBMK])?$/);
		if (!match) {
			const parsed = Number(normalized);
			return Number.isFinite(parsed) ? parsed : null;
		}
		const multiplier =
			{ T: 1e12, B: 1e9, M: 1e6, K: 1e3 }[match[2] as "T" | "B" | "M" | "K"] ??
			1;
		const parsed = Number(match[1]);
		return Number.isFinite(parsed) ? parsed * multiplier : null;
	}
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
