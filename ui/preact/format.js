const FORMATTERS = {
  currency: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }),
  number: new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }),
  sig4: new Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 4,
    minimumSignificantDigits: 4,
    useGrouping: false,
  }),
};

export function normalizeTicker(ticker) {
  return String(ticker || "").replace("-", ".").toUpperCase();
}

export function cleanNumericString(value) {
  return String(value).trim().toUpperCase().replace(/^\$/, "").replace(/,/g, "");
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
  const multiplier =
    suffix === "T"
      ? 1e12
      : suffix === "B"
        ? 1e9
        : suffix === "M"
          ? 1e6
          : suffix === "K"
            ? 1e3
            : 1;
  return numeric * multiplier;
}

export const fmt = {
  currency: (value) => {
    if (value == null) return "--";
    const numeric = Number(value);
    if (Number.isNaN(numeric)) return "--";
    return FORMATTERS.currency.format(numeric);
  },

  percent: (value) => {
    if (value == null) return "--";
    const numeric = Number(value);
    if (Number.isNaN(numeric)) return "--";
    const sign = numeric > 0 ? "+" : "";
    return `${sign}${numeric.toFixed(2)}%`;
  },

  percent_neutral: (value) => {
    if (value == null) return "--";
    const numeric = Number(value);
    if (Number.isNaN(numeric)) return "--";
    return `${numeric.toFixed(2)}%`;
  },

  number: (value) => {
    if (value == null) return "--";
    const numeric = Number(value);
    if (Number.isNaN(numeric)) return "--";
    return FORMATTERS.number.format(numeric);
  },

  score: (value) => {
    if (value == null) return "--";
    const numeric = Number(value);
    if (Number.isNaN(numeric)) return "--";
    return numeric.toFixed(1);
  },

  prob: (value) => {
    if (value == null) return "--";
    const numeric = Number(value);
    if (Number.isNaN(numeric)) return "--";
    return `${(numeric * 100).toFixed(0)}%`;
  },

  market_cap: (value) => {
    if (value == null || value === "") return "--";

    const toSig4 = (n) => {
      const num = Number(n);
      if (Number.isNaN(num)) return null;
      return FORMATTERS.sig4.format(num);
    };

    // Already formatted like 4.534T (or $4.534T)
    const cleaned = cleanNumericString(value);
    const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([TBMK])?$/);
    if (match?.[2]) {
      const rounded = toSig4(match[1]);
      if (!rounded) return "--";
      return `$${rounded}${match[2]}`;
    }

    // Raw dollars
    const numeric = Number(cleaned);
    if (Number.isNaN(numeric)) return "--";

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

    const scaled = numeric / unit.div;
    const rounded = toSig4(scaled);
    return rounded ? `$${rounded}${unit.suf}` : "--";
  },

  default: (value) => (value == null || value === "" ? "--" : String(value)),
};
