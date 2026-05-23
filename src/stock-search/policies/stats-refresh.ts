/** Stats-family policy for cache-vs-live refresh decisions. */

import {
	BLOCKING_AUTO_FAMILIES,
	type StatsFamily,
} from "../stats-resolver/families.js";
import type {
	CachedFamilySnapshot,
	FamilyDecision,
	SourceTier,
	StatsResolutionMode,
} from "../stats-resolver/types.js";

type CacheOnlyResolution = {
	decision: Extract<FamilyDecision, "fresh" | "missing">;
	sourceTier: Extract<SourceTier, "l2" | "missing">;
};

type FamilyRefreshDecision =
	| {
			action: "serve_cache";
			decision: Extract<FamilyDecision, "fresh">;
			sourceTier: SourceTier;
	  }
	| {
			action: "serve_stale_and_queue";
			decision: Extract<FamilyDecision, "stale_served">;
			sourceTier: SourceTier;
	  }
	| { action: "refresh_inline" };

type RefreshFailureDecision = "throw_live" | "serve_stale" | "serve_missing";

export class StatsPolicy {
	/** Decide how cache-only requests should report persisted family rows. */
	cacheOnlyResolution(row: Record<string, unknown>): CacheOnlyResolution {
		return Object.keys(row).length > 0
			? { decision: "fresh", sourceTier: "l2" }
			: { decision: "missing", sourceTier: "missing" };
	}

	/** Decide whether auto mode can use cache or must refresh inline. */
	familyRefreshDecision({
		mode,
		family,
		cached,
	}: {
		mode: StatsResolutionMode;
		family: StatsFamily;
		cached: CachedFamilySnapshot;
	}): FamilyRefreshDecision {
		if (mode === "auto" && cached.isFresh) {
			return {
				action: "serve_cache",
				decision: "fresh",
				sourceTier: cached.sourceTier,
			};
		}

		if (
			mode === "auto" &&
			cached.isStale &&
			cached.hasRequiredFields &&
			!BLOCKING_AUTO_FAMILIES.has(family)
		) {
			return {
				action: "serve_stale_and_queue",
				decision: "stale_served",
				sourceTier: cached.sourceTier,
			};
		}

		return { action: "refresh_inline" };
	}

	/** Decide the fallback path after a live family refresh fails. */
	refreshFailureDecision({
		mode,
		cached,
	}: {
		mode: StatsResolutionMode;
		cached: CachedFamilySnapshot;
	}): RefreshFailureDecision {
		if (mode === "live") {
			return "throw_live";
		}
		return cached.isStale && cached.present ? "serve_stale" : "serve_missing";
	}
}
