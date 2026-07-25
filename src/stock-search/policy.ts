/** Central policy facade for request and stats-resolution workflows. */

export {
  DEFAULT_PORTFOLIO_SCOPE,
  DEFAULT_TICKER_SOURCE,
  PORTFOLIO_SCOPE_POLICIES,
  PORTFOLIO_SCOPE_VALUES,
  type PortfolioBrowserCachePolicy,
  type PortfolioRefreshIntent,
  type PortfolioScope,
  type PortfolioScopePolicy,
  type PortfolioStatsModePolicy,
  type PortfolioUniversePolicy,
  RequestPolicy,
  TICKER_SOURCE_VALUES,
  type TickerSource,
} from "./policies/request.js";
export { StatsPolicy } from "./policies/stats-refresh.js";

import { RequestPolicy } from "./policies/request.js";
import { StatsPolicy } from "./policies/stats-refresh.js";

export const policy = {
  request: new RequestPolicy(),
  stats: new StatsPolicy(),
} as const;
