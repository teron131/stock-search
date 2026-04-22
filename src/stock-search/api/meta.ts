/** Metadata helpers for API responses. */

import { nowIso } from "../utils.js";
import { getStore } from "./data-store.js";

export { nowIso };

export async function statsCacheGeneratedAt(): Promise<string | null> {
	return getStore().getMetaValue("stats_generated_at");
}
