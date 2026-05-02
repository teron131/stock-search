export const DEFAULT_VIEW = "dashboard";

export const VIEW_ROUTES = [
	{
		view: "dashboard",
		path: "/dashboard",
		label: "DASHBOARD",
		title: "Dashboard - Stock Search",
	},
	{
		view: "news",
		path: "/news",
		label: "NEWS",
		title: "News - Stock Search",
	},
	{
		view: "sectors",
		path: "/sectors",
		label: "SECTORS",
		title: "Sectors - Stock Search",
	},
	{
		view: "marketmap",
		path: "/marketmap",
		label: "MARKET MAP",
		title: "Market Map - Stock Search",
	},
	{
		view: "calendar",
		path: "/calendar",
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
