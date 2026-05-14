import { WIDTH_GROUP_OPTIONS } from "../../config.js";
import { fmt, normalizeTicker, parseMarketCap } from "../../format.js";
import { getColumnCharCount } from "../../tableStyle.js";

const NON_US_SUFFIXES = new Set(["HK", "JP", "KR", "KS", "KQ", "TT", "TW"]);
const US_EXCHANGE_PREFIXES = new Set(["AMEX", "NASDAQ", "NYSE"]);

export function getTickerDisplayValue(ticker) {
	return normalizeTicker(ticker).replace("-", ".");
}

export function isNonUsTicker(ticker) {
	const displayTicker = getTickerDisplayValue(ticker);
	if (/^\d/.test(displayTicker)) {
		return true;
	}

	const [prefix, prefixedSymbol] = displayTicker.includes(":")
		? displayTicker.split(":", 2)
		: ["", ""];
	if (prefixedSymbol) {
		return !US_EXCHANGE_PREFIXES.has(prefix);
	}

	const suffix = displayTicker.match(/\.([A-Z]{1,4})$/)?.[1];
	return suffix ? NON_US_SUFFIXES.has(suffix) : false;
}

export function isNonUsLookthroughRow(row) {
	return Boolean(row?.etf_lookthrough_only) && isNonUsTicker(row?.ticker);
}

function isEtfLikeRow(row) {
	const equityType = String(row?.equity_type ?? "")
		.trim()
		.toUpperCase();
	const quoteType = String(row?.quote_type ?? "")
		.trim()
		.toUpperCase();
	return equityType === "ETF" || quoteType === "ETF";
}

export function getTickerCellLabel(row) {
	const ticker = getTickerDisplayValue(row?.ticker);
	const name = String(row?.name || "").trim();
	if (!isNonUsLookthroughRow(row) || !name || name === ticker) {
		return ticker;
	}
	return name
		.replace(/\bCorporation\b/gi, "Corp")
		.replace(/\bIncorporated\b/gi, "Inc.")
		.replace(/\s+(Co\.,?\s*)?Ltd\.?$/i, "")
		.replace(/\s+Inc\.?$/i, "")
		.replace(/\s+Corp\.?$/i, "")
		.trim();
}

export function normalizeSearchText(value) {
	return String(value ?? "")
		.trim()
		.toUpperCase();
}

export function rowMatchesNormalizedSearch(row, normalizedQuery) {
	const ticker = normalizeSearchText(row?.ticker);
	const displayTicker = normalizeSearchText(getTickerDisplayValue(row?.ticker));
	const label = normalizeSearchText(getTickerCellLabel(row));
	const name = normalizeSearchText(row?.name);

	return [ticker, displayTicker, label, name].some((value) =>
		value.includes(normalizedQuery),
	);
}

export function getColumnClassName(key) {
	return `table-col-${String(key || "").replaceAll("_", "-")}`;
}

export function getColumnClusterClassName(cluster) {
	return cluster ? `table-cluster-${cluster}` : "";
}

function compareNullable(a, b, dir) {
	if (a == null) return 1;
	if (b == null) return -1;

	const na = typeof a === "string" ? a.toLowerCase() : a;
	const nb = typeof b === "string" ? b.toLowerCase() : b;

	if (na === nb) return 0;
	return dir === "asc" ? (na < nb ? -1 : 1) : na < nb ? 1 : -1;
}

function notionalTotal(value) {
	if (!value || typeof value !== "object") return null;
	const total =
		Number(value.from_stocks ?? 0) +
		Number(value.from_etf ?? 0) +
		Number(value.from_options ?? 0);
	return Number.isFinite(total) ? total : null;
}

export function rowBelongsToTab(row, tab) {
	const qty = Number(row.quantity);
	const hasQty = row.quantity != null && !Number.isNaN(qty);
	const isHolding = hasQty && qty > 0 && row.total != null;
	const hasEvalScore = row.overall_score != null && row.overall_score !== "";
	const hasEvalRank = row.rank != null;
	const isEval = hasEvalScore || hasEvalRank;
	const isLookthroughRepresentative =
		Boolean(row.etf_lookthrough_only) && (notionalTotal(row.notional) ?? 0) > 0;

	if (tab === "all") return isHolding || isEval || isLookthroughRepresentative;
	if (tab === "holdings") return isHolding;
	return isEval;
}

function stripCurrencySymbol(value) {
	return String(value).replace(/^\$/, "");
}

export function isProxiedStatCell(row, key) {
	return (
		Array.isArray(row?.proxied_stat_fields) &&
		row.proxied_stat_fields.includes(key)
	);
}

export function formatCellValue(row, col) {
	if (
		col.key === "market_cap" &&
		isEtfLikeRow(row) &&
		!isProxiedStatCell(row, col.key)
	) {
		return "--";
	}
	const formatter = fmt[col.format] || fmt.default;
	const formatted = formatter(row[col.key]);
	if (isNonUsTicker(row?.ticker) && col.format === "currency") {
		return stripCurrencySymbol(formatted);
	}
	return formatted;
}

export function sortRows(rows, col, dir) {
	const sorted = [...rows];
	sorted.sort((a, b) => {
		if (col === "market_cap") {
			return compareNullable(
				parseMarketCap(a.market_cap),
				parseMarketCap(b.market_cap),
				dir,
			);
		}

		return compareNullable(a[col], b[col], dir);
	});
	return sorted;
}

export function getAriaSort(sortCol, sortDir, key) {
	if (sortCol !== key) return "none";
	return sortDir === "asc" ? "ascending" : "descending";
}

function getColumnDisplayValues(rows, col) {
	if (col.key === "ticker") {
		return rows.map((row) => getTickerCellLabel(row));
	}

	return rows.map((row) => formatCellValue(row, col));
}

export function getColumnCharCounts(rows, cols) {
	const columnCharCounts = {};

	for (const col of cols) {
		if (col.key === "ticker" || col.key === "remove") {
			continue;
		}

		const charCount = getColumnCharCount(
			getColumnDisplayValues(rows, col),
			col.label || "",
			WIDTH_GROUP_OPTIONS[col.widthGroup],
		);

		columnCharCounts[col.key] = charCount;
	}

	return columnCharCounts;
}
