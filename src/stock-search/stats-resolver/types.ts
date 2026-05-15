/** Shared types for family-based ticker stat resolution. */

import type { StatsFamily } from "../stats-families.js";

export type StatsResolutionMode = "auto" | "live" | "cache";

export type FamilyDecision =
	| "fresh"
	| "stale_served"
	| "inline_refresh"
	| "missing";
export type SourceTier = "l1" | "l2" | "live" | "missing";

export type FamilyResolution = {
	family: StatsFamily;
	row: Record<string, unknown>;
	decision: FamilyDecision;
	sourceTier: SourceTier;
	timestamp: number | null;
	queuedRefresh: boolean;
};

export type StatsResolutionResult = {
	row: Record<string, unknown>;
	dataSource: "cache" | "live" | "live_with_cache_fallback";
	families: Partial<Record<StatsFamily, FamilyResolution>>;
};

export type FamilyCacheEntry = {
	value: Record<string, unknown>;
	updatedAt: number;
	lastFailureAt: number | null;
};

export type CachedFamilySnapshot = {
	sourceTier: SourceTier;
	row: Record<string, unknown>;
	timestamp: number | null;
	isFresh: boolean;
	isStale: boolean;
	present: boolean;
};
