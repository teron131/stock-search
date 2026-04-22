import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/stock-search/api/app.js";
import { appConfig } from "../../src/stock-search/api/config.js";
import type {
	BackendStore,
	CachedNewsRow,
	PortfolioRecord,
	PositionRow,
	StockEntry,
} from "../../src/stock-search/api/data-store.js";

class FakeStore implements BackendStore {
	backendName = "sqlite" as const;
	portfolio: PortfolioRecord = {
		positions: [{ ticker: "NVDA", quantity: 10 }],
		portfolioStats: null,
	};
	stocks: Record<string, StockEntry> = {
		NVDA: {
			indicators: { price: 123.45, change_percent_1d: 1.5, rsi: 54.2 },
			evaluation: { overall_score: 9.1, quality_score: 8.7 },
			labels: ["Technology"],
		},
	};
	news: CachedNewsRow[] = [];
	meta = new Map<string, string>([["stats_generated_at", "2026-04-18T00:00:00+00:00"]]);

	async loadPortfolio(): Promise<PortfolioRecord> {
		return structuredClone(this.portfolio);
	}

	async savePortfolio(input: PortfolioRecord): Promise<void> {
		this.portfolio = structuredClone(input);
	}

	async loadPositions(): Promise<PositionRow[]> {
		return structuredClone(this.portfolio.positions);
	}

	async savePositions(positions: PositionRow[]): Promise<void> {
		this.portfolio.positions = structuredClone(positions);
	}

	async loadStocks(): Promise<Record<string, StockEntry>> {
		return structuredClone(this.stocks);
	}

	async loadStock(ticker: string): Promise<StockEntry | null> {
		return structuredClone(this.stocks[ticker]) ?? null;
	}

	async upsertStocks(
		rows: Array<{
			ticker: string;
			indicators?: Record<string, unknown>;
			evaluation?: Record<string, unknown>;
			labels?: string[];
		}>,
	): Promise<void> {
		for (const row of rows) {
			this.stocks[row.ticker] = {
				indicators: structuredClone(row.indicators ?? {}),
				evaluation: structuredClone(row.evaluation ?? {}),
				labels: structuredClone(row.labels ?? []),
			};
		}
	}

	async loadNews(): Promise<CachedNewsRow[]> {
		return structuredClone(this.news);
	}

	async saveNews(rows: CachedNewsRow[]): Promise<void> {
		this.news = structuredClone(rows);
	}

	async getMetaValue(key: string): Promise<string | null> {
		return this.meta.get(key) ?? null;
	}

	async setMetaValue(key: string, value: string): Promise<void> {
		this.meta.set(key, value);
	}
}

async function buildTestApp() {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "stock-search-ts-"));
	const indexFile = path.join(tempDir, "index.html");
	await writeFile(indexFile, "<html><body>TS backend</body></html>", "utf8");
	return {
		app: createApp({ store: new FakeStore(), indexFile }),
	};
}

const originalAuthConfig = {
	authEnabled: appConfig.authEnabled,
	authSecret: appConfig.authSecret,
	authGoogleId: appConfig.authGoogleId,
	authGoogleSecret: appConfig.authGoogleSecret,
	allowedEmail: appConfig.allowedEmail,
};

function makeSessionCookie(
	payload: Record<string, unknown>,
	secret: string,
): string {
	const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signature = createHmac("sha256", secret)
		.update(encodedPayload)
		.digest("base64url");
	return `stock_search_session=${encodedPayload}.${signature}`;
}

describe("TypeScript backend shell", () => {
	afterEach(() => {
		appConfig.authEnabled = originalAuthConfig.authEnabled;
		appConfig.authSecret = originalAuthConfig.authSecret;
		appConfig.authGoogleId = originalAuthConfig.authGoogleId;
		appConfig.authGoogleSecret = originalAuthConfig.authGoogleSecret;
		appConfig.allowedEmail = originalAuthConfig.allowedEmail;
	});

	it("serves the dashboard shell", async () => {
		const { app } = await buildTestApp();
		const response = await app.request("/");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toContain("TS backend");
	});

	it("returns auth session state when auth is disabled", async () => {
		const { app } = await buildTestApp();
		const response = await app.request("/auth/session");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			enabled: false,
			authenticated: false,
			email: null,
		});
	});

	it("fails closed when auth is enabled but AUTH_SECRET is missing", async () => {
		appConfig.authEnabled = true;
		appConfig.authSecret = "";
		appConfig.authGoogleId = "google-client-id";
		appConfig.authGoogleSecret = "google-client-secret";
		appConfig.allowedEmail = "allowed@example.com";

		const { app } = await buildTestApp();
		const response = await app.request("/");

		expect(response.status).toBe(503);
		expect(await response.text()).toContain(
			"Authentication is not fully configured.",
		);
	});

	it("rejects an expired signed session cookie on the server side", async () => {
		appConfig.authEnabled = true;
		appConfig.authSecret = "test-secret";
		appConfig.authGoogleId = "google-client-id";
		appConfig.authGoogleSecret = "google-client-secret";
		appConfig.allowedEmail = "allowed@example.com";

		const { app } = await buildTestApp();
		const expiredCookie = makeSessionCookie(
			{
				email: "allowed@example.com",
				name: "Allowed User",
				sub: "google-sub",
				iat: 1_700_000_000,
				exp: 1_700_000_100,
			},
			appConfig.authSecret,
		);

		const response = await app.request("/auth/session", {
			headers: {
				cookie: expiredCookie,
			},
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			enabled: true,
			authenticated: false,
			email: null,
		});
	});
});
