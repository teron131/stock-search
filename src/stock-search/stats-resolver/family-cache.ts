/** Cache and freshness helpers for stat-family snapshots. */

import { cacheFreshnessFromTimestamp, parseCacheTimestamp } from "../cache.js";
import {
	FAMILY_FIELDS,
	FAMILY_POLICIES,
	FAMILY_TIMESTAMP_FIELD,
	REQUIRED_FAMILY_FIELDS,
	type StatsFamily,
} from "../stats-families.js";
import type {
	CachedFamilySnapshot,
	FamilyCacheEntry,
	SourceTier,
} from "./types.js";

export const familyCaches: Record<
	StatsFamily,
	Map<string, FamilyCacheEntry>
> = {
	market_data: new Map(),
	market_snapshot: new Map(),
	statistics: new Map(),
	financials: new Map(),
	ratings: new Map(),
};

export function familyTimestamp(
	row: Record<string, unknown>,
	family: StatsFamily,
): number | null {
	return parseCacheTimestamp(row[FAMILY_TIMESTAMP_FIELD[family]]);
}

export function familyRow(
	row: Record<string, unknown>,
	family: StatsFamily,
): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	for (const field of FAMILY_FIELDS[family]) {
		if (field in row) {
			output[field] = row[field];
		}
	}
	return output;
}

export function completeKnownFamilyRow(
	row: Record<string, unknown>,
	family: StatsFamily,
): Record<string, unknown> {
	return Object.fromEntries(
		FAMILY_FIELDS[family].map((field) => [
			field,
			row[field] === undefined ? null : row[field],
		]),
	);
}

function hasMeaningfulPayload(value: unknown): boolean {
	if (value == null) {
		return false;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toUpperCase();
		return normalized !== "" && normalized !== "NONE";
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	if (typeof value === "object") {
		return Object.keys(value as Record<string, unknown>).length > 0;
	}
	return true;
}

function hasKnownFields(
	row: Record<string, unknown>,
	fields: readonly string[],
): boolean {
	return fields.every((field) => field in row && row[field] !== undefined);
}

function hasFamilyPayload(
	row: Record<string, unknown>,
	family: StatsFamily,
): boolean {
	return FAMILY_FIELDS[family].some((field) =>
		hasMeaningfulPayload(row[field]),
	);
}

function hasKnownFamilySnapshot(
	row: Record<string, unknown>,
	family: StatsFamily,
): boolean {
	return (
		hasFamilyPayload(row, family) ||
		((family === "statistics" || family === "financials") &&
			hasKnownFields(row, FAMILY_FIELDS[family]))
	);
}

function hasRequiredFamilyFields(
	row: Record<string, unknown>,
	family: StatsFamily,
): boolean {
	const quoteType = String(row.quote_type ?? "")
		.trim()
		.toUpperCase();
	if (quoteType === "ETF" || quoteType === "MUTUALFUND") {
		return true;
	}
	const requiredFields = REQUIRED_FAMILY_FIELDS[family] ?? [];
	if (
		requiredFields.length > 0 &&
		!requiredFields.every((field) => hasMeaningfulPayload(row[field]))
	) {
		return false;
	}
	if (family === "statistics" || family === "financials") {
		return hasKnownFields(row, FAMILY_FIELDS[family]);
	}
	return true;
}

export function chooseCachedSnapshot(
	ticker: string,
	family: StatsFamily,
	persistedRow: Record<string, unknown>,
	now: number,
): CachedFamilySnapshot {
	const persistedFamilyRow = familyRow(persistedRow, family);
	let sourceTier: SourceTier = "missing";
	let chosenRow: Record<string, unknown> = {};
	let chosenTimestamp = familyTimestamp(persistedRow, family);

	if (hasKnownFamilySnapshot(persistedFamilyRow, family)) {
		sourceTier = "l2";
		chosenRow = persistedFamilyRow;
	}

	const l1Entry = familyCaches[family].get(ticker);
	if (
		l1Entry &&
		hasKnownFamilySnapshot(l1Entry.value, family) &&
		(chosenTimestamp == null || l1Entry.updatedAt >= chosenTimestamp)
	) {
		sourceTier = "l1";
		chosenRow = { ...l1Entry.value };
		chosenTimestamp = l1Entry.updatedAt;
	}

	if (chosenTimestamp == null) {
		return {
			sourceTier,
			row: chosenRow,
			timestamp: null,
			hasRequiredFields: false,
			isFresh: false,
			isStale: false,
			present: Object.keys(chosenRow).length > 0,
		};
	}

	const policy = FAMILY_POLICIES[family];
	const freshness = cacheFreshnessFromTimestamp(chosenTimestamp, now, policy);
	const hasRequiredFields = hasRequiredFamilyFields(
		{ ...persistedRow, ...chosenRow },
		family,
	);
	const present = Object.keys(chosenRow).length > 0;
	return {
		sourceTier,
		row: chosenRow,
		timestamp: freshness.timestamp,
		hasRequiredFields,
		isFresh: hasRequiredFields && freshness.isFresh,
		isStale: present && freshness.isStale,
		present,
	};
}

export function mergeFamilyRow(
	baseRow: Record<string, unknown>,
	family: StatsFamily,
	nextRow: Record<string, unknown>,
	timestamp: number,
): Record<string, unknown> {
	const merged = { ...baseRow };
	for (const field of FAMILY_FIELDS[family]) {
		if (!(field in nextRow)) {
			continue;
		}
		merged[field] = nextRow[field];
	}
	merged[FAMILY_TIMESTAMP_FIELD[family]] = new Date(timestamp).toISOString();
	return merged;
}
