/** StockAnalysis provider adapter implementation. */

import { z } from "zod";

import {
	scrapeEtfHoldingsSnapshot,
	scrapeEtfSectorsSnapshot,
} from "./page-scrapers/etf-holdings.js";
import { scrapeFinancialsSnapshot } from "./page-scrapers/financials.js";
import { scrapeIndustrySnapshot } from "./page-scrapers/industry.js";
import {
	scrapeQuoteFields,
	scrapeStatisticsSnapshot,
} from "./page-scrapers/statistics.js";
import {
	invokeStockanalysisSearch,
	invokeStockanalysisSearchOrDefault,
} from "./exa-fallback.js";
import {
	ETF_HOLDINGS_SEARCH_SYSTEM_PROMPT,
	ETF_SECTOR_SEARCH_SYSTEM_PROMPT,
	FINANCIALS_SYSTEM_PROMPT,
	STATISTICS_SYSTEM_PROMPT,
} from "./prompts.js";
import {
	STOCKANALYSIS_FINANCIALS_URL,
	STOCKANALYSIS_STATISTICS_URL,
} from "./urls.js";
import type {
	StockAnalysisEtfSnapshot,
	StockAnalysisFinancials,
	StockAnalysisIndicatorsSnapshot,
	StockAnalysisIndustrySnapshot,
	StockAnalysisStatistics,
} from "./schemas.js";

const stockAnalysisStatisticsSchema = z.object({
	market_cap: z.number().nullable().optional(),
	beta: z.number().nullable().optional(),
	fifty_two_week_price_change: z.number().nullable().optional(),
	moving_average_50d: z.number().nullable().optional(),
	moving_average_200d: z.number().nullable().optional(),
	rsi: z.number().nullable().optional(),
	average_volume_20d: z.number().nullable().optional(),
	pe: z.number().nullable().optional(),
	pe_forward: z.number().nullable().optional(),
	peg: z.number().nullable().optional(),
	roic: z.number().nullable().optional(),
	gross_margin: z.number().nullable().optional(),
	operating_margin: z.number().nullable().optional(),
	debt_to_equity: z.number().nullable().optional(),
	debt_to_ebitda: z.number().nullable().optional(),
	free_cash_flow: z.number().nullable().optional(),
});
const stockAnalysisFinancialsSchema = z.object({
	revenue_growth: z.number().nullable().optional(),
	eps_diluted: z.number().nullable().optional(),
	eps_growth: z.number().nullable().optional(),
	gross_margin: z.number().nullable().optional(),
	operating_margin: z.number().nullable().optional(),
});
const etfHoldingsSchema = z.object({
	holdings: z
		.array(
			z.object({
				ticker: z.string(),
				name: z.string().nullable().optional(),
				weight: z.number(),
			}),
		)
		.default([]),
});
const etfSectorsSchema = z.object({
	sectors: z
		.array(
			z.object({
				name: z.string(),
				weight: z.number(),
			}),
		)
		.default([]),
});

function hasModelData(snapshot: Record<string, unknown> | null | undefined): boolean {
	return !!snapshot && Object.values(snapshot).some((value) => {
		if (value == null) {
			return false;
		}
		if (Array.isArray(value)) {
			return value.length > 0;
		}
		return true;
	});
}

/** Fetch sector and industry summary rows from the StockAnalysis industries page. */
export async function getIndustrySnapshot(): Promise<StockAnalysisIndustrySnapshot> {
	return scrapeIndustrySnapshot();
}

export class StockAnalysisSource {
	private readonly tickerUpper: string;
	private readonly tickerLower: string;
	private statisticsSnapshot: StockAnalysisStatistics | null = null;
	private etfSnapshot: StockAnalysisEtfSnapshot | null = null;
	private financialsSnapshot: StockAnalysisFinancials | null = null;
	private indicatorsSnapshot: StockAnalysisIndicatorsSnapshot | null = null;

	/** Initialize the StockAnalysis adapter for one ticker. */
	constructor(private readonly ticker: string) {
		this.tickerUpper = ticker.toUpperCase().trim();
		this.tickerLower = this.tickerUpper.toLowerCase();
	}

	private async loadSnapshot<T extends Record<string, unknown>>({
		snapshotGetter,
		scrapeGetter,
		searchGetter,
	}: {
		snapshotGetter: () => T | null;
		scrapeGetter: () => Promise<T>;
		searchGetter: () => Promise<T>;
	}): Promise<T> {
		const cached = snapshotGetter();
		if (cached) {
			return cached;
		}

		const scraped = await scrapeGetter();
		if (hasModelData(scraped)) {
			return scraped;
		}
		return searchGetter();
	}

	/** Fetch statistics once and reuse cached data on later calls. */
	async getStatisticsSnapshot(): Promise<StockAnalysisStatistics> {
		this.statisticsSnapshot ??= await this.loadSnapshot({
			snapshotGetter: () => this.statisticsSnapshot,
			scrapeGetter: async () => scrapeStatisticsSnapshot(this.tickerLower),
			searchGetter: async () => this.searchStatisticsSnapshot(),
		});
		return this.statisticsSnapshot;
	}

	/** Fetch financials once and reuse cached data on later calls. */
	async getFinancialsSnapshot(): Promise<StockAnalysisFinancials> {
		this.financialsSnapshot ??= await this.loadSnapshot({
			snapshotGetter: () => this.financialsSnapshot,
			scrapeGetter: async () => scrapeFinancialsSnapshot(this.tickerLower),
			searchGetter: async () => this.searchFinancialsSnapshot(),
		});
		return this.financialsSnapshot;
	}

	private async searchStatisticsSnapshot(): Promise<StockAnalysisStatistics> {
		const statisticsUrl = STOCKANALYSIS_STATISTICS_URL.replace(
			"{ticker}",
			this.tickerLower,
		);
		return invokeStockanalysisSearch({
			outputSchema: stockAnalysisStatisticsSchema,
			systemPromptTemplate: STATISTICS_SYSTEM_PROMPT,
			query: `${statisticsUrl} ${this.tickerUpper} statistics key ratios valuation market cap`,
			promptValues: {
				ticker: this.tickerUpper,
				statistics_url: statisticsUrl,
			},
		});
	}

	private async searchFinancialsSnapshot(): Promise<StockAnalysisFinancials> {
		const financialsUrl = STOCKANALYSIS_FINANCIALS_URL.replace(
			"{ticker}",
			this.tickerLower,
		);
		return invokeStockanalysisSearch({
			outputSchema: stockAnalysisFinancialsSchema,
			systemPromptTemplate: FINANCIALS_SYSTEM_PROMPT,
			query: `${financialsUrl} ${this.tickerUpper} financials revenue growth eps growth gross margin`,
			promptValues: {
				ticker: this.tickerUpper,
				financials_url: financialsUrl,
			},
		});
	}

	private async searchEtfHoldings(): Promise<
		Array<{ ticker: string; name: string | null; weight: number }>
	> {
		const payload = await invokeStockanalysisSearchOrDefault({
			outputSchema: etfHoldingsSchema,
			systemPromptTemplate: ETF_HOLDINGS_SEARCH_SYSTEM_PROMPT,
			query: `${this.tickerUpper} ETF holdings weights stock analysis`,
			promptValues: { ticker: this.tickerLower },
			defaultFactory: () => ({ holdings: [] }),
		});
		return payload.holdings.map((holding) => ({
			ticker: holding.ticker,
			name: holding.name ?? null,
			weight: holding.weight,
		}));
	}

	private async searchEtfSectors(): Promise<Array<{ name: string; weight: number }>> {
		const payload = await invokeStockanalysisSearchOrDefault({
			outputSchema: etfSectorsSchema,
			systemPromptTemplate: ETF_SECTOR_SEARCH_SYSTEM_PROMPT,
			query: `${this.tickerUpper} ETF sector allocation weights stock analysis schwab`,
			promptValues: { ticker: this.tickerLower },
			defaultFactory: () => ({ sectors: [] }),
		});
		return payload.sectors;
	}

	/** Fetch ETF holdings and sector data for one ticker. */
	async getEtfHoldingsSnapshot(): Promise<StockAnalysisEtfSnapshot> {
		if (this.etfSnapshot) {
			return this.etfSnapshot;
		}

		let holdings = await scrapeEtfHoldingsSnapshot(this.tickerLower);
		if (holdings.length === 0) {
			holdings = await this.searchEtfHoldings();
		}
		let sectors = await scrapeEtfSectorsSnapshot(this.tickerLower);
		if (sectors.length === 0) {
			sectors = await this.searchEtfSectors();
		}
		this.etfSnapshot = {
			holdings,
			sectors,
			error:
				holdings.length === 0 && sectors.length === 0
					? "no snapshot returned"
					: null,
		};
		return this.etfSnapshot;
	}

	/** Return an app-facing StockAnalysis indicator set. */
	async getIndicatorsSnapshot(): Promise<StockAnalysisIndicatorsSnapshot> {
		if (this.indicatorsSnapshot) {
			return this.indicatorsSnapshot;
		}

		const [statistics, financials] = await Promise.all([
			this.getStatisticsSnapshot(),
			this.getFinancialsSnapshot(),
		]);
		const quoteFields = await scrapeQuoteFields(this.tickerLower);
		this.indicatorsSnapshot = {
			...quoteFields,
			...statistics,
			...financials,
			gross_margin:
				financials.gross_margin ?? statistics.gross_margin ?? null,
			debt_to_equity: statistics.debt_to_equity ?? null,
		};
		return this.indicatorsSnapshot;
	}
}
