/** CLI executable entrypoint that delegates to the curated command adapter. */

import { main } from "./cli.js";

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
