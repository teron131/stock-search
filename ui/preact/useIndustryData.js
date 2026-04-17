import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "preact/hooks";

import { CONFIG } from "./config.js";
import { normalizeIndustryPayload } from "./dataContract.js";
import {
	buildIndustryViewModel,
	buildSectorOptions,
} from "./industryViewModel.js";

function withCacheBuster(url) {
	const cacheBuster = `_=${Date.now()}`;
	return url.includes("?") ? `${url}&${cacheBuster}` : `${url}?${cacheBuster}`;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(withCacheBuster(url), {
			signal: controller.signal,
		});
		if (!response.ok) return null;
		return await response.json();
	} finally {
		clearTimeout(timeoutId);
	}
}

export function useIndustryData({ enabled = false } = {}) {
	const [industries, setIndustries] = useState([]);
	const [meta, setMeta] = useState({
		source: "stockanalysis",
		fetched_at: null,
		sector_count: 0,
		industry_count: 0,
	});
	const [selectedSector, setSelectedSector] = useState("ALL");
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
			const rawPayload = await fetchJsonWithTimeout(
				CONFIG.endpoints.industries,
				CONFIG.requestTimeoutMs.industries,
			);
			const payload = normalizeIndustryPayload(rawPayload);
			if (!payload) {
				throw new Error("Industry API failure");
			}

			hasRequestedRef.current = true;
			setIndustries(payload.industries);
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

	const sectorOptions = useMemo(
		() => buildSectorOptions(industries),
		[industries],
	);

	useEffect(() => {
		if (
			selectedSector !== "ALL" &&
			!sectorOptions.some((option) => option.sector === selectedSector)
		) {
			setSelectedSector("ALL");
		}
	}, [sectorOptions, selectedSector]);

	const viewModel = useMemo(
		() =>
			buildIndustryViewModel(industries, {
				selectedSector,
				sortKey,
				sortDirection,
			}),
		[industries, selectedSector, sortDirection, sortKey],
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
		industries,
		meta,
		isLoading,
		lastError,
		sectorOptions,
		selectedSector,
		setSelectedSector,
		sortKey,
		sortDirection,
		setSortKey: toggleSortKey,
		refresh,
		...viewModel,
	};
}
