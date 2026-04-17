function toNumericOrNull(value) {
	if (value == null) return null;
	const numeric = Number(value);
	return Number.isNaN(numeric) ? null : numeric;
}

function compareNullable(a, b, direction) {
	if (a == null && b == null) return 0;
	if (a == null) return 1;
	if (b == null) return -1;
	if (a === b) return 0;
	return direction === "asc" ? (a < b ? -1 : 1) : a < b ? 1 : -1;
}

function average(values) {
	if (!values.length) return null;
	const total = values.reduce((sum, value) => sum + value, 0);
	return total / values.length;
}

function averageIndustryField(industries, key) {
	return average(
		industries
			.map((industry) => toNumericOrNull(industry[key]))
			.filter((value) => value != null),
	);
}

function getSortValue(industry, sortKey) {
	if (sortKey === "sector") {
		return String(industry.sector || "").toLowerCase();
	}
	if (sortKey === "industry") {
		return String(industry.industry || "").toLowerCase();
	}
	if (sortKey === "stock_count") {
		return toNumericOrNull(industry.stock_count);
	}
	if (sortKey === "market_cap") {
		return toNumericOrNull(industry.market_cap);
	}
	return toNumericOrNull(industry[sortKey]);
}

function sortIndustries(industries, sortKey, sortDirection) {
	return [...industries].sort((left, right) => {
		const leftValue = getSortValue(left, sortKey);
		const rightValue = getSortValue(right, sortKey);
		const compared = compareNullable(leftValue, rightValue, sortDirection);
		if (compared !== 0) return compared;
		return String(left.industry || "").localeCompare(
			String(right.industry || ""),
		);
	});
}

export const INDUSTRY_SORT_OPTIONS = [
	{ key: "stock_count", label: "STOCKS" },
	{ key: "change_percent_1d", label: "1D" },
	{ key: "change_percent_1m", label: "1M" },
	{ key: "change_percent_1y", label: "1Y" },
	{ key: "market_cap", label: "MKT CAP" },
	{ key: "gross_margin", label: "GROSS" },
	{ key: "profit_margin", label: "PROFIT" },
	{ key: "pe", label: "PE" },
];

export function buildSectorOptions(industries) {
	const sectorMap = new Map();
	industries.forEach((industry) => {
		const sectorName = String(industry.sector || "").trim();
		if (!sectorName) return;
		if (!sectorMap.has(sectorName)) {
			sectorMap.set(sectorName, []);
		}
		sectorMap.get(sectorName).push(industry);
	});

	const sectors = Array.from(sectorMap.entries()).map(([sector, rows]) => {
		const avg1d = average(
			rows
				.map((row) => toNumericOrNull(row.change_percent_1d))
				.filter((value) => value != null),
		);
		return {
			sector,
			count: rows.length,
			avg_change_percent_1d: avg1d,
		};
	});

	const allSector = {
		sector: "ALL",
		count: industries.length,
		avg_change_percent_1d: average(
			industries
				.map((industry) => toNumericOrNull(industry.change_percent_1d))
				.filter((value) => value != null),
		),
	};

	sectors.sort((left, right) => {
		const compared = compareNullable(
			left.avg_change_percent_1d,
			right.avg_change_percent_1d,
			"desc",
		);
		if (compared !== 0) return compared;
		return left.sector.localeCompare(right.sector);
	});

	return [allSector, ...sectors];
}

export function buildIndustryViewModel(
	industries,
	{
		selectedSector = "ALL",
		sortKey = "change_percent_1d",
		sortDirection = "desc",
	} = {},
) {
	const filteredIndustries =
		selectedSector === "ALL"
			? [...industries]
			: industries.filter((industry) => industry.sector === selectedSector);

	const sortedIndustries = sortIndustries(
		filteredIndustries,
		sortKey,
		sortDirection,
	);

	const oneDayMoves = filteredIndustries
		.map((industry) => toNumericOrNull(industry.change_percent_1d))
		.filter((value) => value != null);
	const advancingCount = oneDayMoves.filter((value) => value > 0).length;
	const decliningCount = oneDayMoves.filter((value) => value < 0).length;
	const unchangedCount = oneDayMoves.filter((value) => value === 0).length;

	return {
		filteredIndustries,
		sortedIndustries,
		marketSummary: {
			industryCount: filteredIndustries.length,
			marketCap: averageIndustryField(filteredIndustries, "market_cap"),
			pe: averageIndustryField(filteredIndustries, "pe"),
			profitMargin: averageIndustryField(filteredIndustries, "profit_margin"),
			grossMargin: averageIndustryField(filteredIndustries, "gross_margin"),
			changePercent1d: averageIndustryField(
				filteredIndustries,
				"change_percent_1d",
			),
			changePercent1m: averageIndustryField(
				filteredIndustries,
				"change_percent_1m",
			),
			changePercent1y: averageIndustryField(
				filteredIndustries,
				"change_percent_1y",
			),
		},
		breadth: {
			advancingCount,
			decliningCount,
			unchangedCount,
			averageChangePercent1d: average(oneDayMoves),
		},
	};
}
