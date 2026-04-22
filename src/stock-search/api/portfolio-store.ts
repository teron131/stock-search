/** Portfolio-position store helpers. */

import { normalizeTicker } from "../utils.js";
import type { PositionRow } from "./data-store.js";
import { loadPositions, savePositions } from "./data-store.js";

export function findPositionIndex(positions: PositionRow[], ticker: string): number {
	const tickerSymbol = normalizeTicker(ticker);
	return positions.findIndex(
		(position) => normalizeTicker(position.ticker) === tickerSymbol,
	);
}

export { loadPositions, savePositions };
