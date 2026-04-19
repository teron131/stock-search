const ICON_DEFS = {
	dot: {
		paths: ["M8 5.75a2.25 2.25 0 1 0 0 4.5a2.25 2.25 0 0 0 0-4.5Z"],
	},
	grid: {
		paths: [
			"M2.5 2.5h4v4h-4Z",
			"M9.5 2.5h4v4h-4Z",
			"M2.5 9.5h4v4h-4Z",
			"M9.5 9.5h4v4h-4Z",
		],
	},
	factory: {
		paths: [
			"M2.5 13.5V7.5l3-1.75V8.5l3-1.75V9.5l3-1.75V13.5",
			"M11.5 5V2.75h2V13.5",
			"M2.5 13.5h11",
		],
	},
	heatmap: {
		paths: [
			"M2.5 12.75V8.5h3v4.25Z",
			"M6.5 12.75V5.25h3v7.5Z",
			"M10.5 12.75V6.75h3v6Z",
			"M2.5 3.25h11",
		],
	},
	calendar: {
		paths: [
			"M3.25 4.75h9.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-6.5a1 1 0 0 1 1-1Z",
			"M5.25 2.75V5.5",
			"M10.75 2.75V5.5",
			"M2.25 7.25h11.5",
		],
	},
	news: {
		paths: [
			"M3.25 2.75h9.5v10.5h-9.5Z",
			"M5.25 5.25h5.5",
			"M5.25 7.75h5.5",
			"M5.25 10.25h3.25",
		],
	},
	chip: {
		paths: [
			"M5 5h6v6H5Z",
			"M6.5 2.75v1.5",
			"M9.5 2.75v1.5",
			"M6.5 11.75v1.5",
			"M9.5 11.75v1.5",
			"M2.75 6.5h1.5",
			"M2.75 9.5h1.5",
			"M11.75 6.5h1.5",
			"M11.75 9.5h1.5",
		],
	},
	cross: {
		paths: ["M8 3.25v9.5", "M3.25 8h9.5", "M4.25 4.25h7.5v7.5h-7.5Z"],
	},
	heart: {
		paths: [
			"M8 12.75 3.5 8.5a2.75 2.75 0 0 1 0-3.89 2.8 2.8 0 0 1 3.96 0L8 5.16l.54-.55a2.8 2.8 0 0 1 3.96 0 2.75 2.75 0 0 1 0 3.89Z",
		],
	},
	bank: {
		paths: [
			"M2.5 6.25 8 3l5.5 3.25",
			"M3.5 6.25v5.5",
			"M6.5 6.25v5.5",
			"M9.5 6.25v5.5",
			"M12.5 6.25v5.5",
			"M2.5 12.5h11",
		],
	},
	bolt: {
		paths: ["M9.25 2.75 5 8h2.75l-1 5.25L11 7.75H8.25Z"],
	},
	bag: {
		paths: ["M4 5.75h8l-.5 7h-7Z", "M5.5 5.75a2.5 2.5 0 0 1 5 0"],
	},
	basket: {
		paths: [
			"M3.5 6.25h9l-1 6h-7Z",
			"M5.5 6.25 8 3.75l2.5 2.5",
			"M6 8.25v2.5",
			"M8 8.25v2.5",
			"M10 8.25v2.5",
		],
	},
	antenna: {
		paths: [
			"M8 12.75V8.5",
			"M6.25 12.75h3.5",
			"M8 8 10.75 5.25",
			"M8 8 5.25 5.25",
			"M11.5 4.5a4.5 4.5 0 0 0-7 0",
		],
	},
	building: {
		paths: [
			"M4 2.75h5v10.5H4Z",
			"M9 5.25h3v8H9",
			"M5.25 4.5h1.5",
			"M5.25 7h1.5",
			"M5.25 9.5h1.5",
			"M10 7h1",
			"M10 9.5h1",
			"M3.25 13.25h9.5",
		],
	},
	gem: {
		paths: [
			"M4.5 4.25h7L13.75 7 8 13 2.25 7Z",
			"M6.25 4.25 8 7l1.75-2.75",
			"M4.5 4.25 2.25 7",
			"M11.5 4.25 13.75 7",
			"M8 7v6",
		],
	},
	plug: {
		paths: [
			"M6 2.75v3",
			"M10 2.75v3",
			"M5.25 5.75h5.5v2a2.75 2.75 0 0 1-2.75 2.75H8v2.75",
		],
	},
};

const NAV_ICON_NAMES = {
	dashboard: "grid",
	news: "news",
	industry: "factory",
	marketmap: "heatmap",
	calendar: "calendar",
};

const SECTOR_ICON_NAMES = {
	all: "grid",
	technology: "chip",
	healthcare: "heart",
	financials: "bank",
	energy: "bolt",
	industrials: "factory",
	"consumer discretionary": "bag",
	"consumer staples": "basket",
	"communication services": "antenna",
	"real estate": "building",
	materials: "gem",
	utilities: "plug",
};

const SECTOR_DISPLAY_LABELS = {
	all: "ALL",
	technology: "TECH",
	healthcare: "HEALTH",
	financials: "FINANCIALS",
	energy: "ENERGY",
	industrials: "INDUSTRIALS",
	"consumer discretionary": "CONS DISC",
	"consumer staples": "CONS STAPLES",
	"communication services": "COMM SVCS",
	"real estate": "REAL ESTATE",
	materials: "MATERIALS",
	utilities: "UTILITIES",
};

const ICON_SYMBOLS = {
	grid: "G",
	news: "N",
	factory: "I",
	heatmap: "H",
	calendar: "C",
	chip: "T",
	cross: "H",
	heart: "H",
	bank: "F",
	bolt: "E",
	bag: "D",
	basket: "S",
	antenna: "C",
	building: "R",
	gem: "M",
	plug: "U",
	dot: "I",
};

function normalizeSectorKey(sector) {
	return String(sector || "")
		.trim()
		.toLowerCase();
}

export function getIconDefinition(iconName) {
	return ICON_DEFS[iconName] || ICON_DEFS.dot;
}

export function getNavIconName(viewName) {
	return (
		NAV_ICON_NAMES[
			String(viewName || "")
				.trim()
				.toLowerCase()
		] || "dot"
	);
}

export function getSectorIconName(sector) {
	return SECTOR_ICON_NAMES[normalizeSectorKey(sector)] || "dot";
}

export function getSectorIconSymbol(sector) {
	return ICON_SYMBOLS[getSectorIconName(sector)] || "I";
}

export function getSectorDisplayLabel(sector) {
	return (
		SECTOR_DISPLAY_LABELS[normalizeSectorKey(sector)] || String(sector || "")
	);
}
