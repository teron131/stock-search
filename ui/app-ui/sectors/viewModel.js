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

function averageSectorField(sectors, key) {
  return average(
    sectors.map((sector) => toNumericOrNull(sector[key])).filter((value) => value != null),
  );
}

function getSortValue(sector, sortKey) {
  if (sortKey === "sector") {
    return String(sector.sector || "").toLowerCase();
  }
  if (sortKey === "stock_count") {
    return toNumericOrNull(sector.stock_count);
  }
  if (sortKey === "market_cap") {
    return toNumericOrNull(sector.market_cap);
  }
  return toNumericOrNull(sector[sortKey]);
}

function sortSectors(sectors, sortKey, sortDirection) {
  return [...sectors].sort((left, right) => {
    const leftValue = getSortValue(left, sortKey);
    const rightValue = getSortValue(right, sortKey);
    const compared = compareNullable(leftValue, rightValue, sortDirection);
    if (compared !== 0) return compared;
    return String(left.sector || "").localeCompare(String(right.sector || ""));
  });
}

export function buildSectorViewModel(
  sectors,
  { sortKey = "change_percent_1d", sortDirection = "desc" } = {},
) {
  const filteredSectors = [...sectors];

  const sortedSectors = sortSectors(filteredSectors, sortKey, sortDirection);

  const oneDayMoves = filteredSectors
    .map((sector) => toNumericOrNull(sector.change_percent_1d))
    .filter((value) => value != null);
  const advancingCount = oneDayMoves.filter((value) => value > 0).length;
  const decliningCount = oneDayMoves.filter((value) => value < 0).length;
  const unchangedCount = oneDayMoves.filter((value) => value === 0).length;

  return {
    filteredSectors,
    sortedSectors,
    marketSummary: {
      sectorCount: filteredSectors.length,
      marketCap: averageSectorField(filteredSectors, "market_cap"),
      pe: averageSectorField(filteredSectors, "pe"),
      profitMargin: averageSectorField(filteredSectors, "profit_margin"),
      changePercent1d: averageSectorField(filteredSectors, "change_percent_1d"),
      changePercent1y: averageSectorField(filteredSectors, "change_percent_1y"),
    },
    breadth: {
      advancingCount,
      decliningCount,
      unchangedCount,
      averageChangePercent1d: average(oneDayMoves),
    },
  };
}
