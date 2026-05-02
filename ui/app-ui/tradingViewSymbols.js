const COMMON_US_SYMBOL_PATTERN = /^[A-Z]{1,5}$/;
const US_EXCHANGE_PREFIXES = new Set(["AMEX", "NASDAQ", "NYSE"]);

export function normalizeTickerLabel(ticker) {
	return String(ticker || "")
		.trim()
		.toUpperCase();
}

function getTickerValue(input) {
	return typeof input === "object" && input !== null ? input.ticker : input;
}

function isFundLikeInstrument(input, options) {
	const quoteType = normalizeTickerLabel(
		options.quoteType ?? input?.quote_type,
	);
	const equityType = normalizeTickerLabel(
		options.equityType ?? input?.equity_type,
	);
	return quoteType === "ETF" || equityType === "ETF" || equityType === "FUND";
}

function splitTradingViewPrefix(ticker) {
	const [prefix, symbol] = ticker.includes(":")
		? ticker.split(":", 2)
		: ["", ticker];
	return { prefix, symbol };
}

export function getTradingViewTickerTagSymbol(input, options = {}) {
	if (isFundLikeInstrument(input, options) && !options.allowFunds) {
		return "";
	}

	const normalizedTicker = normalizeTickerLabel(getTickerValue(input)).replace(
		"-",
		".",
	);
	if (!normalizedTicker) {
		return "";
	}

	const { prefix, symbol } = splitTradingViewPrefix(normalizedTicker);
	if (prefix) {
		if (!US_EXCHANGE_PREFIXES.has(prefix)) {
			return "";
		}
		return COMMON_US_SYMBOL_PATTERN.test(symbol) ? `${prefix}:${symbol}` : "";
	}

	if (!COMMON_US_SYMBOL_PATTERN.test(normalizedTicker)) {
		return "";
	}

	return normalizedTicker;
}

export function getTradingViewTickerTapeSymbol(input, options = {}) {
	const symbol = getTradingViewTickerTagSymbol(input, options);
	if (!symbol || symbol.includes(":")) return "";
	return symbol.toLowerCase();
}

export function buildTradingViewTickerTapeSymbols(
	rows,
	{ limit, maxLength } = {},
) {
	const symbols = [];
	const seen = new Set();

	for (const row of rows || []) {
		const symbol = getTradingViewTickerTapeSymbol(row);
		if (!symbol || seen.has(symbol)) {
			continue;
		}
		if (maxLength && symbol.length >= maxLength) {
			continue;
		}

		seen.add(symbol);
		symbols.push(symbol);
		if (limit && symbols.length >= limit) {
			break;
		}
	}

	return symbols;
}

export function isTradingViewSymbolError(error) {
	const message =
		typeof error === "string"
			? error
			: error?.message || error?.reason || String(error || "");
	return (
		message.includes("[tv] no_such_symbol") ||
		message.includes("[tv] invalid symbol")
	);
}
