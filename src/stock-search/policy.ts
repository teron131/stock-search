/** Workflow policy tables for request modes and portfolio orchestration. */

export const PORTFOLIO_SCOPE_VALUES = [
	"priority",
	"all_cached",
	"portfolio_live",
	"all",
] as const;
export const TICKER_SOURCE_VALUES = ["auto", "live", "cache"] as const;

export type PortfolioScope = (typeof PORTFOLIO_SCOPE_VALUES)[number];
export type TickerSource = (typeof TICKER_SOURCE_VALUES)[number];
export type PortfolioUniversePolicy = "portfolio" | "all_stored";
export type PortfolioStatsModePolicy = "cache" | "auto";
export type PortfolioRefreshIntent =
	| "repair_missing_required"
	| "none"
	| "held_and_evaluated"
	| "held_or_evaluated";
export type PortfolioBrowserCachePolicy = "no_store" | "private_short";

export type PortfolioScopePolicy = {
	universe: PortfolioUniversePolicy;
	statsMode: PortfolioStatsModePolicy;
	refreshIntent: PortfolioRefreshIntent;
	liveRefresh: boolean;
	refreshLabels: boolean;
	persistPortfolioStats: boolean;
	browserCache: PortfolioBrowserCachePolicy;
};

export const DEFAULT_PORTFOLIO_SCOPE: PortfolioScope = "priority";
export const DEFAULT_TICKER_SOURCE: TickerSource = "auto";

export const PORTFOLIO_SCOPE_POLICIES: Record<
	PortfolioScope,
	PortfolioScopePolicy
> = {
	priority: {
		universe: "portfolio",
		statsMode: "auto",
		refreshIntent: "repair_missing_required",
		liveRefresh: false,
		refreshLabels: false,
		persistPortfolioStats: false,
		browserCache: "no_store",
	},
	all_cached: {
		universe: "all_stored",
		statsMode: "cache",
		refreshIntent: "none",
		liveRefresh: false,
		refreshLabels: false,
		persistPortfolioStats: false,
		browserCache: "private_short",
	},
	portfolio_live: {
		universe: "portfolio",
		statsMode: "auto",
		refreshIntent: "held_and_evaluated",
		liveRefresh: true,
		refreshLabels: false,
		persistPortfolioStats: true,
		browserCache: "no_store",
	},
	all: {
		universe: "all_stored",
		statsMode: "auto",
		refreshIntent: "held_or_evaluated",
		liveRefresh: true,
		refreshLabels: true,
		persistPortfolioStats: false,
		browserCache: "no_store",
	},
};

export function portfolioScopePolicy(
	scope: PortfolioScope,
): PortfolioScopePolicy {
	return PORTFOLIO_SCOPE_POLICIES[scope];
}

export function portfolioCacheControl(scope: PortfolioScope): string {
	return portfolioScopePolicy(scope).browserCache === "private_short"
		? "private, max-age=30, stale-while-revalidate=300"
		: "no-store";
}

export function isTickerSource(value: unknown): value is TickerSource {
	return (
		typeof value === "string" &&
		(TICKER_SOURCE_VALUES as readonly string[]).includes(value)
	);
}
