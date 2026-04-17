const VIEW_PATHS = {
	dashboard: "/dashboard",
	industry: "/industry",
	marketmap: "/marketmap",
	calendar: "/calendar",
};

const PATH_VIEWS = {
	"/": "dashboard",
	"/dashboard": "dashboard",
	"/industry": "industry",
	"/marketmap": "marketmap",
	"/calendar": "calendar",
};

export function getViewForPath(pathname) {
	return PATH_VIEWS[String(pathname || "").trim()] || "dashboard";
}

export function getPathForView(view) {
	return VIEW_PATHS[String(view || "").trim()] || VIEW_PATHS.dashboard;
}
