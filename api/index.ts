import app from "../src/stock-search/api/app.js";
import { verifyStoreStartup } from "../src/stock-search/storage/index.js";

void verifyStoreStartup().catch((error) => {
	console.warn(
		"Store startup verification failed; continuing without blocking startup.",
		error,
	);
});

export default app;
