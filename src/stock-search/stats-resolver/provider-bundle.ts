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

	/** Return the cached Yahoo price and momentum payload. */
	getYahooIndicators(): Promise<Record<string, unknown>> {
		this.yahooPromise ??= this.yahooSource.getIndicatorsSnapshot();
		return this.yahooPromise;
	}

	/** Return the cached Yahoo symbol metadata payload. */
	getYahooMetadata(): Promise<Record<string, unknown>> {
		this.yahooMetaPromise ??= this.yahooSource.getSymbolMetadataSnapshot();
		return this.yahooMetaPromise;
	}

	/** Return the cached StockAnalysis statistics payload. */
	getStockAnalysisStatistics(): Promise<Record<string, unknown>> {
		this.stockAnalysisStatisticsPromise ??=
			this.stockAnalysisSource.getStatisticsSnapshot();
		return this.stockAnalysisStatisticsPromise;
	}

	/** Return the cached StockAnalysis financials payload. */
	getStockAnalysisFinancials(): Promise<Record<string, unknown>> {
		this.stockAnalysisFinancialsPromise ??=
			this.stockAnalysisSource.getFinancialsSnapshot();
		return this.stockAnalysisFinancialsPromise;
	}

	/** Return throttled Finviz slow-statistics fields, falling back to empty on provider limits. */
	getFinvizStatistics(): Promise<Record<string, unknown>> {
		this.finvizStatisticsPromise ??= this.finvizSource
			.getStatisticsSnapshot()
			.catch(() => ({}));
		return this.finvizStatisticsPromise;
	}
}
