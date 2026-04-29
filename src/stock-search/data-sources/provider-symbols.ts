/** Normalize app tickers into provider-specific symbols and paths. */

import { normalizeTicker } from "../utils.js";

type ProviderExchange = {
	yahooSuffix: string;
	stockAnalysisSlug: string;
};

type PrefixedTicker = {
	exchangeCode: string;
	symbol: string;
	exchange: ProviderExchange | null;
};

const PROVIDER_EXCHANGES: Record<string, ProviderExchange> = {
	HK: { yahooSuffix: "HK", stockAnalysisSlug: "hkg" },
	JP: { yahooSuffix: "T", stockAnalysisSlug: "tyo" },
	KQ: { yahooSuffix: "KQ", stockAnalysisSlug: "kosdaq" },
	KS: { yahooSuffix: "KS", stockAnalysisSlug: "krx" },
	KRX: { yahooSuffix: "KS", stockAnalysisSlug: "krx" },
	LON: { yahooSuffix: "L", stockAnalysisSlug: "lon" },
	TT: { yahooSuffix: "TW", stockAnalysisSlug: "tpe" },
	TW: { yahooSuffix: "TW", stockAnalysisSlug: "tpe" },
};

const US_EXCHANGE_PREFIXES = new Set(["AMEX", "NASDAQ", "NYSE"]);

function splitExchangePrefix(ticker: string): PrefixedTicker | null {
	const match = ticker.match(/^([A-Z]{2,6}):(.+)$/);
	if (!match?.[1] || !match[2]) {
		return null;
	}
	return {
		exchangeCode: match[1],
		symbol: match[2],
		exchange: PROVIDER_EXCHANGES[match[1]] ?? null,
	};
}

function splitSuffix(ticker: string): [string, ProviderExchange] | null {
	const match = ticker.match(/^(.+)\.([A-Z]{1,4})$/);
	const exchange = match?.[2] ? PROVIDER_EXCHANGES[match[2]] : null;
	return match?.[1] && exchange ? [match[1], exchange] : null;
}

/** Return the Yahoo Finance symbol for an app ticker. */
export function yahooSymbolForTicker(tickerInput: string): string {
	const ticker = normalizeTicker(tickerInput);
	const prefixed = splitExchangePrefix(ticker);
	if (prefixed?.exchange) {
		return `${prefixed.symbol}.${prefixed.exchange.yahooSuffix}`;
	}
	if (prefixed && US_EXCHANGE_PREFIXES.has(prefixed.exchangeCode)) {
		return prefixed.symbol.replace(/\./g, "-");
	}

	const suffixed = splitSuffix(ticker);
	if (suffixed) {
		const [symbol, exchange] = suffixed;
		return `${symbol}.${exchange.yahooSuffix}`;
	}

	return ticker.replace(/ /g, "-").replace(/\./g, "-");
}

/** Return the StockAnalysis stock path segment for an app ticker. */
export function stockAnalysisStockPathForTicker(tickerInput: string): string {
	const ticker = normalizeTicker(tickerInput);
	const prefixed = splitExchangePrefix(ticker);
	if (prefixed) {
		if (prefixed.exchange) {
			return `quote/${prefixed.exchange.stockAnalysisSlug}/${prefixed.symbol}`;
		}
		if (US_EXCHANGE_PREFIXES.has(prefixed.exchangeCode)) {
			return `stocks/${prefixed.symbol.toLowerCase()}`;
		}
		return `quote/${prefixed.exchangeCode.toLowerCase()}/${prefixed.symbol}`;
	}

	const suffixed = splitSuffix(ticker);
	if (suffixed) {
		const [symbol, exchange] = suffixed;
		return `quote/${exchange.stockAnalysisSlug}/${symbol}`;
	}

	return `stocks/${ticker.toLowerCase()}`;
}
