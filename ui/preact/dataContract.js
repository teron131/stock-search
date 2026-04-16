import { normalizeTicker } from "./format.js";

function normalizeDashboardRowsPayload(payload) {
	if (!payload || typeof payload !== "object") {
		return null;
	}

	if (!Array.isArray(payload.rows)) {
		return null;
	}

	const rows = payload.rows
		.filter((row) => row && typeof row === "object")
		.map((row) => ({ ...row, ticker: normalizeTicker(row.ticker) }));

	return {
		rows,
		generated_at:
			typeof payload.meta?.generated_at === "string"
				? payload.meta.generated_at
				: null,
		portfolio_stats:
			payload.portfolio_stats && typeof payload.portfolio_stats === "object"
				? payload.portfolio_stats
				: null,
	};
}

export function normalizeApiDashboardPayload(payload) {
	const normalized = normalizeDashboardRowsPayload(payload);
	if (!normalized) return null;
	return normalized;
}
