const VIEW_PATHS = {
	dashboard: "/dashboard",
	news: "/news",
	sectors: "/sectors",
	marketmap: "/marketmap",
	calendar: "/calendar",
};

const PATH_VIEWS = {
	"/": "dashboard",
	"/dashboard": "dashboard",
	"/news": "news",
	"/sectors": "sectors",
	"/marketmap": "marketmap",
	"/calendar": "calendar",
};

export function getViewForPath(pathname) {
	const normalizedPath = String(pathname || "")
		.trim()
		.replace(/\/+$/, "");
	return PATH_VIEWS[normalizedPath || "/"] || "dashboard";
}

export function getPathForView(view) {
	return VIEW_PATHS[String(view || "").trim()] || VIEW_PATHS.dashboard;
}
