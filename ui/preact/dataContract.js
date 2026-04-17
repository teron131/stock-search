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

export function normalizeIndustryPayload(payload) {
	if (!payload || typeof payload !== "object") {
		return null;
	}

	const industries = Array.isArray(payload.industries)
		? payload.industries.filter(
				(industry) => industry && typeof industry === "object",
			)
		: null;
	if (!industries) {
		return null;
	}

	const meta =
		payload.meta && typeof payload.meta === "object" ? payload.meta : {};

	return {
		industries: industries.map((industry) => ({ ...industry })),
		meta: {
			source:
				typeof meta.source === "string" && meta.source
					? meta.source
					: "stockanalysis",
			fetched_at:
				typeof meta.fetched_at === "string" && meta.fetched_at
					? meta.fetched_at
					: null,
			sector_count: Number(meta.sector_count) || 0,
			industry_count: Number(meta.industry_count) || 0,
		},
	};
}
