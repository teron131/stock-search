/** Memoize provider calls needed to resolve one ticker's stat families. */

import {
	fetchStockAnalysisFinancials,
	fetchStockAnalysisStatistics,
	fetchYahooIndicators,
	fetchYahooSymbolMetadata,
} from "../indicators.js";

export class ProviderBundle {
	private yahooPromise: Promise<Record<string, unknown>> | null = null;
	private yahooMetaPromise: Promise<Record<string, unknown>> | null = null;
	private statisticsPromise: Promise<Record<string, unknown>> | null = null;
	private financialsPromise: Promise<Record<string, unknown>> | null = null;

	constructor(private readonly ticker: string) {}

	/** Return the cached Yahoo price and momentum payload. */
	getYahooIndicators(): Promise<Record<string, unknown>> {
		this.yahooPromise ??= fetchYahooIndicators(this.ticker);
		return this.yahooPromise;
	}

	/** Return the cached Yahoo symbol metadata payload. */
	getYahooMetadata(): Promise<Record<string, unknown>> {
		this.yahooMetaPromise ??= fetchYahooSymbolMetadata(this.ticker);
		return this.yahooMetaPromise;
	}

	/** Return the cached StockAnalysis statistics payload. */
	getStatistics(): Promise<Record<string, unknown>> {
		this.statisticsPromise ??= fetchStockAnalysisStatistics(this.ticker);
		return this.statisticsPromise;
	}

	/** Return the cached StockAnalysis financials payload. */
	getFinancials(): Promise<Record<string, unknown>> {
		this.financialsPromise ??= fetchStockAnalysisFinancials(this.ticker);
		return this.financialsPromise;
	}
}
