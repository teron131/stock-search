/** Structured Finviz quote-page snapshot shapes. */

export type FinvizQuoteSnapshot = {
	ticker: string;
	source: "finviz";
	fetched_at: string | null;
	url: string;
	raw: Record<string, string>;
	sector_name: string | null;
	industry_name: string | null;
	price: number | null;
	market_cap: number | null;
	revenue: number | null;
	pe: number | null;
	/** Finviz "Forward P/E" as displayed; the provider owns the exact FY1/NTM definition. */
	pe_forward: number | null;
	ps: number | null;
	/** Finviz "PEG" as displayed, not recomputed by this parser. */
	peg: number | null;
	beta: number | null;
	rsi: number | null;
	roe: number | null;
	roic: number | null;
	gross_margin: number | null;
	operating_margin: number | null;
	profit_margin: number | null;
	debt_to_equity: number | null;
	revenue_growth: number | null;
	/** Finviz growth values are parsed as percentage points, so "16.55%" becomes 16.55. */
	eps_this_y_growth: number | null;
	eps_next_y_growth: number | null;
	eps_next_5y_growth: number | null;
	/** First value from Finviz "EPS past 3/5Y". */
	eps_past_3y_growth: number | null;
	/** Second value from Finviz "EPS past 3/5Y". */
	eps_past_5y_growth: number | null;
	/** First value from Finviz "Sales past 3/5Y". */
	sales_past_3y_growth: number | null;
	/** Second value from Finviz "Sales past 3/5Y". */
	sales_past_5y_growth: number | null;
	eps_yoy_ttm_growth: number | null;
};
