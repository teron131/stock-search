import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import app from "./stock-search/api/app.js";
import { appConfig } from "./stock-search/api/config.js";
import { verifyStoreStartup } from "./stock-search/storage/startup.js";

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
