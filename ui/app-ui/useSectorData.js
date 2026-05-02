import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { CONFIG } from "./config.js";
import { normalizeSectorPayload } from "./dataContract.js";
import { buildSectorViewModel } from "./sectorViewModel.js";

async function fetchJsonWithTimeout(url, timeoutMs) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
		});
		if (!response.ok) return null;
		return await response.json();
	} finally {
		clearTimeout(timeoutId);
	}
}

export function useSectorData({ enabled = false } = {}) {
	const [sectors, setSectors] = useState([]);
	const [meta, setMeta] = useState({
		source: "stockanalysis-sectors",
		fetched_at: null,
		sector_count: 0,
	});
	const [sortKey, setSortKey] = useState("change_percent_1d");
	const [sortDirection, setSortDirection] = useState("desc");
	const [isLoading, setIsLoading] = useState(false);
	const [lastError, setLastError] = useState(null);

	const hasRequestedRef = useRef(false);
	const requestInFlightRef = useRef(false);

	const refresh = useCallback(async () => {
		if (requestInFlightRef.current) return;

		requestInFlightRef.current = true;
		setIsLoading(true);
		setLastError(null);
		try {
			const endpoints = CONFIG.isDemoMode
				? [CONFIG.demoEndpoints.sectors]
				: [CONFIG.endpoints.sectors];

			let payload = null;
			for (const endpoint of endpoints) {
				const rawPayload = await fetchJsonWithTimeout(
					endpoint,
					CONFIG.requestTimeoutMs.sectors,
				);
				payload = normalizeSectorPayload(rawPayload);
				if (payload) {
					break;
				}
			}
			if (!payload) {
				throw new Error("Sector API failure");
			}

			hasRequestedRef.current = true;
			setSectors(payload.sectors);
			setMeta(payload.meta);
		} catch (error) {
			setLastError(error);
		} finally {
			requestInFlightRef.current = false;
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!enabled || hasRequestedRef.current) return;
		refresh();
	}, [enabled, refresh]);

	const viewModel = useMemo(
		() =>
			buildSectorViewModel(sectors, {
				sortKey,
				sortDirection,
			}),
		[sectors, sortDirection, sortKey],
	);

	const toggleSortKey = useCallback(
		(nextSortKey) => {
			setSortDirection((currentDirection) =>
				nextSortKey === sortKey && currentDirection === "desc" ? "asc" : "desc",
			);
			setSortKey(nextSortKey);
		},
		[sortKey],
	);

	return {
		sectors,
		meta,
		isLoading,
		lastError,
		sortKey,
		sortDirection,
		setSortKey: toggleSortKey,
		refresh,
		...viewModel,
	};
}
