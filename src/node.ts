import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { appConfig } from "./stock-search/api/config.js";
import { verifyStoreStartup } from "./stock-search/api/data-store.js";
import app from "./stock-search/api/app.js";

const nodeApp = new Hono();
nodeApp.route("/", app);
nodeApp.use(
	"*",
	serveStatic({
		root: appConfig.uiDir,
	}),
);

await verifyStoreStartup();

serve({
	fetch: nodeApp.fetch,
	hostname: appConfig.nodeHost,
	port: appConfig.nodePort,
});
