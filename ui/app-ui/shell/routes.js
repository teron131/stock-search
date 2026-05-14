export const DEFAULT_VIEW = "dashboard";

export const APP_BASE_PATH = normalizeBasePath(
	process.env.NEXT_PUBLIC_BASE_PATH,
);

function normalizeBasePath(value) {
	const trimmed = String(value || "").trim();
	if (!trimmed || trimmed === "/") {
		return "";
	}
	return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export function appPath(path) {
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	return `${APP_BASE_PATH}${normalizedPath}`;
}

export const VIEW_ROUTES = [
	{
		view: "dashboard",
		path: appPath("/dashboard"),
		label: "DASHBOARD",
		title: "Dashboard - Stock Search",
	},
	{
		view: "news",
		path: appPath("/news"),
		label: "NEWS",
		title: "News - Stock Search",
	},
	{
		view: "sectors",
		path: appPath("/sectors"),
		label: "SECTORS",
		title: "Sectors - Stock Search",
	},
	{
		view: "marketmap",
		path: appPath("/marketmap"),
		label: "MARKET MAP",
		title: "Market Map - Stock Search",
	},
	{
		view: "calendar",
		path: appPath("/calendar"),
		label: "ECONOMIC CALENDAR",
		title: "Calendar - Stock Search",
	},
];

const VIEW_TITLES = Object.fromEntries(
	VIEW_ROUTES.map((route) => [route.view, route.title]),
);

export function getMetadataForView(view) {
	return {
		title: VIEW_TITLES[String(view || "").trim()] || VIEW_TITLES[DEFAULT_VIEW],
	};
}
