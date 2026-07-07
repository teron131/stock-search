/** Memoize provider calls needed to resolve one ticker's stat families. */

import { FinvizSource } from "../data-sources/finviz/source.js";
import { StockAnalysisSource } from "../data-sources/stockanalysis/index.js";
import { YahooFinanceSource } from "../data-sources/yahoo-finance.js";

export class ProviderBundle {
	private readonly yahooSource: YahooFinanceSource;
	private readonly stockAnalysisSource: StockAnalysisSource;
	private readonly finvizSource: FinvizSource;
	private yahooPromise: Promise<Record<string, unknown>> | null = null;
	private yahooMetaPromise: Promise<Record<string, unknown>> | null = null;
	private stockAnalysisStatisticsPromise: Promise<
		Record<string, unknown>
	> | null = null;
	private stockAnalysisFinancialsPromise: Promise<
		Record<string, unknown>
	> | null = null;
	private finvizStatisticsPromise: Promise<Record<string, unknown>> | null =
		null;

	constructor(ticker: string) {
		this.yahooSource = new YahooFinanceSource(ticker);
		this.stockAnalysisSource = new StockAnalysisSource(ticker);
		this.finvizSource = new FinvizSource(ticker);
	}

	/** Memoize Yahoo price and momentum fields for all families in this ticker resolution. */
	getYahooIndicators(): Promise<Record<string, unknown>> {
		this.yahooPromise ??= this.yahooSource.getIndicatorsSnapshot();
		return this.yahooPromise;
	}

	/** Memoize Yahoo metadata so quote type and currency are fetched once per ticker. */
	getYahooMetadata(): Promise<Record<string, unknown>> {
		this.yahooMetaPromise ??= this.yahooSource.getSymbolMetadataSnapshot();
		return this.yahooMetaPromise;
	}

	/** Memoize StockAnalysis statistics for field-policy merges. */
	getStockAnalysisStatistics(): Promise<Record<string, unknown>> {
		this.stockAnalysisStatisticsPromise ??=
			this.stockAnalysisSource.getStatisticsSnapshot();
		return this.stockAnalysisStatisticsPromise;
	}

	/** Memoize StockAnalysis financials for slow fundamental fields. */
	getStockAnalysisFinancials(): Promise<Record<string, unknown>> {
		this.stockAnalysisFinancialsPromise ??=
			this.stockAnalysisSource.getFinancialsSnapshot();
		return this.stockAnalysisFinancialsPromise;
	}

	/** Finviz provider limits degrade to an empty slow-stat snapshot for resolver fallback. */
	getFinvizStatistics(): Promise<Record<string, unknown>> {
		this.finvizStatisticsPromise ??= this.finvizSource
			.getStatisticsSnapshot()
			.catch(() => ({}));
		return this.finvizStatisticsPromise;
	}
}
