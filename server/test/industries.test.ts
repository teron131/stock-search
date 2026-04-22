import { describe, expect, it } from "vitest";

import { getIndustrySnapshot } from "../../src/stock-search/data-sources/stockanalysis/adapter.js";

describe("industry service", () => {
	it("returns a normalized payload shape", async () => {
		const snapshot = await getIndustrySnapshot();

		expect(snapshot.meta.source).toBe("stockanalysis");
		expect(Array.isArray(snapshot.industries)).toBe(true);
		if (snapshot.industries.length > 0) {
			expect(snapshot.industries[0]).toEqual(
				expect.objectContaining({
					sector: expect.any(String),
					industry: expect.any(String),
					stock_count: expect.any(Number),
				}),
			);
		}
	});
});
