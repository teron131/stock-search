import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CONFIG } from "../config.js";
import { normalizeTicker } from "../format.js";
import { fetchJsonWithTimeout, isAbortError } from "../portfolio/api.js";

function finitePositive(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric > 0;
}

function getHoldingTickers(rows) {
	return [
		...new Set(
			(rows || [])
				.filter((row) => finitePositive(row?.quantity) && row?.total != null)
				.map((row) => normalizeTicker(row?.ticker))
				.filter(Boolean),
		),
	];
}

function normalizeCorrelationPayload(payload) {
	if (
		!payload ||
		typeof payload !== "object" ||
		!Array.isArray(payload.tickers)
	) {
		return null;
	}
	return {
		...payload,
		tickers: payload.tickers.map(normalizeTicker).filter(Boolean),
		normalMatrixRounded: payload.normalMatrixRounded || {
			tickers: [],
			values: [],
		},
		tailMatrixPsd: payload.tailMatrixPsd || { tickers: [], values: [] },
		statsPercent: Array.isArray(payload.statsPercent)
			? payload.statsPercent
			: [],
		diagnostics:
			payload.diagnostics && typeof payload.diagnostics === "object"
				? payload.diagnostics
				: { components: {} },
	};
}

export function useCorrelationData({ rows, enabled, mode }) {
	const [payload, setPayload] = useState(null);
	const [isLoading, setIsLoading] = useState(false);
	const [lastError, setLastError] = useState(null);
	const abortRef = useRef(null);

	const tickers = useMemo(() => getHoldingTickers(rows), [rows]);
	const refresh = useCallback(async () => {
		if (!enabled || tickers.length < 2) {
			setPayload(null);
			setLastError(null);
			return;
		}

		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		setIsLoading(true);
		setLastError(null);

		try {
			const params = new URLSearchParams({
				mode,
				tickers: tickers.join(","),
			});
			const response = await fetchJsonWithTimeout(
				`${CONFIG.endpoints.portfolioCorrelation}?${params.toString()}`,
				CONFIG.requestTimeoutMs.correlation,
				controller.signal,
			);
			const nextPayload = normalizeCorrelationPayload(response);
			if (!nextPayload) {
				throw new Error("Correlation unavailable");
			}
			setPayload(nextPayload);
		} catch (error) {
			if (!isAbortError(error)) {
				setPayload(null);
				setLastError(error);
			}
		} finally {
			if (abortRef.current === controller) {
				abortRef.current = null;
				setIsLoading(false);
			}
		}
	}, [enabled, mode, tickers]);

	useEffect(() => {
		void refresh();
		return () => {
			abortRef.current?.abort();
		};
	}, [refresh]);

	return {
		payload,
		isLoading,
		lastError,
		mode,
		tickers,
		refresh,
	};
}
