import { describe, expect, it } from "vitest";

import {
	buildPortfolioPayload,
	mergePortfolioRow,
} from "../../src/stock-search/portfolio.js";
import { resolveTickerStats } from "../../src/stock-search/stats-resolver.js";
import type {
	BackendStore,
	CachedNewsRow,
	PortfolioRecord,
	PositionRow,
	StockEntry,
} from "../../src/stock-search/api/data-store.js";

class MemoryStore implements BackendStore {
	backendName = "sqlite" as const;

	constructor(
		public portfolio: PortfolioRecord,
		public stocks: Record<string, StockEntry>,
	) {}

	async loadPortfolio(): Promise<PortfolioRecord> {
		return structuredClone(this.portfolio);
	}

	async savePortfolio(input: PortfolioRecord): Promise<void> {
		this.portfolio = structuredClone(input);
	}

	async loadPositions(): Promise<PositionRow[]> {
		return structuredClone(this.portfolio.positions);
	}

	async savePositions(positions: PositionRow[]): Promise<void> {
		this.portfolio.positions = structuredClone(positions);
	}

	async loadStocks(): Promise<Record<string, StockEntry>> {
		return structuredClone(this.stocks);
	}

	async loadStock(ticker: string): Promise<StockEntry | null> {
		return structuredClone(this.stocks[ticker]) ?? null;
	}

	async upsertStocks(
		rows: Array<{
			ticker: string;
			indicators?: Record<string, unknown>;
			evaluation?: Record<string, unknown>;
			labels?: string[];
		}>,
	): Promise<void> {
		for (const row of rows) {
			const existing = this.stocks[row.ticker];
			this.stocks[row.ticker] = {
				indicators: structuredClone(row.indicators ?? existing?.indicators ?? {}),
				evaluation: structuredClone(row.evaluation ?? existing?.evaluation ?? {}),
				labels: structuredClone(row.labels ?? existing?.labels ?? []),
			};
		}
	}

	async loadNews(): Promise<CachedNewsRow[]> {
		return [];
	}

	async saveNews(_rows: CachedNewsRow[]): Promise<void> {}

	async getMetaValue(key: string): Promise<string | null> {
		return key === "stats_generated_at" ? "2026-04-21T00:00:00.000Z" : null;
	}

	async setMetaValue(_key: string, _value: string): Promise<void> {}
}

describe("portfolio service", () => {
	it("falls back to indicator-based default evaluation scores when no evaluation exists", () => {
		const row = mergePortfolioRow(
			{ ticker: "VOO", quantity: 2 },
			{
				indicators: {
					price: 100,
					quote_type: "ETF",
				},
				evaluation: {},
				labels: [],
			},
		);

		expect(row.overall_score).toBe(5);
		expect(row.quality_score).toBe(5);
		expect(row.valuation_score).toBe(5);
		expect(row.moat_score).toBe(5);
		expect(row.upside_score).toBe(5);
		expect(row.bull_probability).toBe(0.5);
		expect(row.bear_probability).toBe(0.2);
		expect(row.eval_source).toBe("indicator_fallback");
		expect(row.equity_type).toBe("ETF");
	});

	it("builds ETF lookthrough sector exposure for held positions", async () => {
		const store = new MemoryStore(
			{
				positions: [
					{ ticker: "AAPL", quantity: 1 },
					{ ticker: "VOO", quantity: 1 },
				],
				portfolioStats: null,
			},
			{
				AAPL: {
					indicators: {
						price: 100,
						quote_type: "EQUITY",
						sector_name: "Technology",
					},
					evaluation: { overall_score: 8.2 },
					labels: ["Technology"],
				},
				VOO: {
					indicators: {
						price: 100,
						quote_type: "ETF",
						etf_holdings: [{ ticker: "AAPL", name: "Apple", weight: 10 }],
						etf_sectors: [
							{ name: "Technology", weight: 60 },
							{ name: "Financials", weight: 40 },
						],
						etf_holdings_fetched_at: "2026-04-21T00:00:00.000Z",
					},
					evaluation: {},
					labels: [],
				},
			},
		);

		const payload = await buildPortfolioPayload(store, "all_cached");
		const sectors = payload.portfolio_stats?.sector_distribution as Array<{
			sector: string;
			portfolio_weight: number;
			stock_weight: number;
			etf_lookthrough_weight: number;
		}>;

		expect(
			payload.rows.find(
				(row: Record<string, unknown>) => row.ticker === "VOO",
			)?.etf_holdings,
		).toEqual(expect.any(Array));
		expect(sectors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sector: "Technology",
					stock_weight: 50,
					etf_lookthrough_weight: 30,
					portfolio_weight: 80,
				}),
				expect.objectContaining({
					sector: "Financials",
					stock_weight: 0,
					etf_lookthrough_weight: 20,
					portfolio_weight: 20,
				}),
			]),
		);
	});
});

describe("stats resolver", () => {
	it("serves stale cached statistics and refreshes them in the background", async () => {
		const staleAt = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
		const freshAt = new Date().toISOString();
		const store = new MemoryStore(
			{
				positions: [],
				portfolioStats: null,
			},
			{
				NVDA: {
					indicators: {
						price: 100,
						change: 1,
						change_percent_1d: 1,
						market_data_fetched_at: freshAt,
						name: "NVIDIA",
						quote_type: "EQUITY",
						sector_name: "Technology",
						industry_name: "Semiconductors",
						market_snapshot_fetched_at: freshAt,
						market_cap: 1_000_000,
						pe: 20,
						statistics_fetched_at: staleAt,
						revenue_growth: 10,
						gross_margin: 50,
						debt_to_equity: 0.2,
						financials_fetched_at: freshAt,
						median_upside: 10,
						ratings: [],
						ratings_fetched_at: freshAt,
					},
					evaluation: {},
					labels: [],
				},
			},
		);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("stockanalysis.com/stocks/nvda/statistics")) {
				return new Response(
					`<html><body>statistics:{shareStatistics:{data:[{id:"marketCap",value:"3.1T",hover:"3100000000000"}]},ratios:{data:[{id:"pe",value:"35.0",hover:"35.0"}]}}</body></html>`,
				);
			}
			return new Response(null, { status: 404 });
		}) as typeof globalThis.fetch;

		try {
			const result = await resolveTickerStats(store, "NVDA", "auto");

			expect(result.row.pe).toBe(20);
			expect(result.families.statistics.decision).toBe("stale_served");
			expect(result.families.statistics.queuedRefresh).toBe(true);

			await new Promise((resolve) => {
				setTimeout(resolve, 25);
			});

			const refreshed = await store.loadStock("NVDA");
			expect(refreshed?.indicators.pe).toBe(35);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
