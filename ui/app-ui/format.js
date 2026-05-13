const FORMATTERS = {
	currency: new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
	}),
	number: new Intl.NumberFormat("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}),
	sig4: new Intl.NumberFormat("en-US", {
		maximumSignificantDigits: 4,
		minimumSignificantDigits: 4,
		useGrouping: false,
	}),
};

const MARKET_CAP_MULTIPLIERS = {
	T: 1e12,
	B: 1e9,
	M: 1e6,
	K: 1e3,
};

function toNumberOrNull(value) {
	if (value == null) return null;
	const numeric = Number(value);
	return Number.isNaN(numeric) ? null : numeric;
}

function toSig4(value) {
	const numeric = toNumberOrNull(value);
	return numeric == null ? null : FORMATTERS.sig4.format(numeric);
}

export function normalizeTicker(ticker) {
	return String(ticker || "")
		.trim()
		.replace(".", "-")
		.toUpperCase();
}

export function cleanNumericString(value) {
	return String(value)
		.trim()
		.toUpperCase()
		.replace(/^[A-Z]{3}\s+/, "")
		.replace(/^\$/, "")
		.replace(/,/g, "");
}

export function parseMarketCap(value) {
	if (value == null) return null;
	if (typeof value === "number") return Number.isNaN(value) ? null : value;

	const raw = cleanNumericString(value);
	const match = raw.match(/^(-?\d+(?:\.\d+)?)([TBMK])?$/);
	if (!match) return null;

	const numeric = Number(match[1]);
	if (Number.isNaN(numeric)) return null;

	const suffix = match[2];
	const multiplier = (suffix && MARKET_CAP_MULTIPLIERS[suffix]) || 1;
	return numeric * multiplier;
}

export const fmt = {
	currency: (value) => {
		const numeric = toNumberOrNull(value);
		if (numeric == null) return "--";
		return FORMATTERS.currency.format(numeric);
	},

	percent: (value) => {
		const numeric = toNumberOrNull(value);
		if (numeric == null) return "--";
		const sign = numeric > 0 ? "+" : "";
		return `${sign}${numeric.toFixed(2)}%`;
	},

	percent_neutral: (value) => {
		const numeric = toNumberOrNull(value);
		if (numeric == null) return "--";
		return `${numeric.toFixed(2)}%`;
	},

	ratio_percent_neutral: (value) => {
		const numeric = toNumberOrNull(value);
		if (numeric == null) return "--";
		const percentage = numeric * 100;
		const digits = Math.abs(percentage) >= 1 ? 0 : 2;
		return `${percentage.toFixed(digits)}%`;
	},

	number: (value) => {
		const numeric = toNumberOrNull(value);
		if (numeric == null) return "--";
		return FORMATTERS.number.format(numeric);
	},

	score: (value) => {
		const numeric = toNumberOrNull(value);
		if (numeric == null) return "--";
		return numeric.toFixed(1);
	},

	prob: (value) => {
		const numeric = toNumberOrNull(value);
		if (numeric == null) return "--";
		return `${(numeric * 100).toFixed(0)}%`;
	},

	market_cap: (value) => {
		if (value == null || value === "") return "--";

		// Already formatted like 4.534T (or $4.534T)
		const cleaned = cleanNumericString(value);
		const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([TBMK])?$/);
		if (match?.[2]) {
			const rounded = toSig4(match[1]);
			return rounded ? `$${rounded}${match[2]}` : "--";
		}

		const numeric = toNumberOrNull(cleaned);
		if (numeric == null) return "--";

		const abs = Math.abs(numeric);
		const units = [
			{ div: 1e12, suf: "T" },
			{ div: 1e9, suf: "B" },
			{ div: 1e6, suf: "M" },
			{ div: 1e3, suf: "K" },
		];

		const unit = units.find((u) => abs >= u.div);
		if (!unit) {
			const rounded = toSig4(numeric);
			return rounded ? `$${rounded}` : "--";
		}

		const rounded = toSig4(numeric / unit.div);
		return rounded ? `$${rounded}${unit.suf}` : "--";
	},

	default: (value) => (value == null || value === "" ? "--" : String(value)),
};
