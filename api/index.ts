import { verifyStoreStartup } from "../src/stock-search/api/data-store.js";
import app from "../src/stock-search/api/app.js";

await verifyStoreStartup();

export default app;
