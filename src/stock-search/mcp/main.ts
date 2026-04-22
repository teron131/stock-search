/** Run the Stock Search FastMCP server. */

import { main } from "./server.js";

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
