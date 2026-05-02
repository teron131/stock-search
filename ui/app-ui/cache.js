export const DAY_IN_MS = 24 * 60 * 60 * 1000;

export function parseCacheTimestamp(value) {
	const timestamp = Date.parse(value || "");
	return Number.isFinite(timestamp) ? timestamp : null;
}

export function isCacheTimestampFresh(value, maxAgeMs, now = Date.now()) {
	const timestamp = parseCacheTimestamp(value);
	return timestamp != null && now - timestamp < maxAgeMs;
}

function getLocalDateKey(value) {
	const timestamp = parseCacheTimestamp(value);
	if (timestamp == null) {
		return null;
	}

	const date = new Date(timestamp);
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

export function isSameLocalDay(value, now = new Date().toISOString()) {
	const nowDayKey = getLocalDateKey(now);
	const valueDayKey = getLocalDateKey(value);
	return Boolean(nowDayKey && valueDayKey && nowDayKey === valueDayKey);
}

export function readLocalStorageJson(key) {
	if (typeof window === "undefined" || !window.localStorage) {
		return null;
	}

	try {
		const rawValue = window.localStorage.getItem(key);
		return rawValue ? JSON.parse(rawValue) : null;
	} catch {
		return null;
	}
}

export function writeLocalStorageJson(key, value) {
	if (typeof window === "undefined" || !window.localStorage) {
		return;
	}

	try {
		window.localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Ignore storage failures and continue with in-memory state.
	}
}
