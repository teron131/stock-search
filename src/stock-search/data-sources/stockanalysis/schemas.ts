/** Structured StockAnalysis snapshot shapes used by the TS provider layer. */

export type StockAnalysisStatistics = Record<string, unknown>;
export type StockAnalysisFinancials = Record<string, unknown>;
export type StockAnalysisIndicatorsSnapshot = Record<string, unknown>;

export type StockAnalysisSectorSummary = {
  sector: string;
  top_tickers: string[];
  stock_count: number;
  market_cap: number | null;
  pe: number | null;
  profit_margin: number | null;
  change_percent_1d: number | null;
  change_percent_1y: number | null;
};

export type StockAnalysisSectorSnapshot = {
  sectors: StockAnalysisSectorSummary[];
  meta: {
    source: string;
    fetched_at: string | null;
    sector_count: number;
  };
};

export type StockAnalysisEtfHolding = {
  ticker: string;
  name: string | null;
  weight: number;
};

export type StockAnalysisEtfSector = {
  name: string;
  weight: number;
};

export type StockAnalysisEtfSnapshot = {
  holdings: StockAnalysisEtfHolding[];
  sectors: StockAnalysisEtfSector[];
  error: string | null;
};
