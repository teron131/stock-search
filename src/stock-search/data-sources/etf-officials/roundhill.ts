import { normalizeTicker } from "../../utils.js";
import { parseNumberText } from "../shared.js";
import type {
	OfficialEtfHolding,
	OfficialEtfHoldingsProvider,
	OfficialEtfHoldingsSnapshot,
} from "./types.js";

type PlaywrightPage = {
	goto(
		url: string,
		options: { waitUntil: "domcontentloaded"; timeout: number },
	): Promise<unknown>;
	waitForSelector(
		selector: string,
		options: { timeout: number },
	): Promise<unknown>;
	$$eval<T>(
		selector: string,
		pageFunction: (elements: Element[]) => T,
	): Promise<T>;
};

type PlaywrightBrowser = {
	newPage(): Promise<PlaywrightPage>;
	close(): Promise<void>;
};

type PlaywrightRuntime = {
	chromium?: {
		launch(options: { headless: boolean }): Promise<PlaywrightBrowser>;
	};
	default?: {
		chromium?: {
			launch(options: { headless: boolean }): Promise<PlaywrightBrowser>;
		};
	};
};

const ROUNDHILL_BASE_URL = "https://www.roundhillinvestments.com/etf/";
const RENDERED_HOLDINGS_SELECTOR = "#fund-topTenHoldings tr";

function roundWeight(value: number): number {
	return Number(value.toFixed(4));
}

/** Parse rows read from Roundhill's rendered official top holdings table. */
export function parseRenderedRoundhillHoldingsRows(
	rows: unknown,
): OfficialEtfHolding[] {
	if (!Array.isArray(rows)) {
		return [];
	}

	const holdings: OfficialEtfHolding[] = [];
	for (const row of rows) {
		if (!Array.isArray(row) || row.length < 3) {
			continue;
		}

		const name = typeof row[0] === "string" ? row[0].trim() : "";
		const ticker = normalizeTicker(row[1]);
		const weight = parseNumberText(row[2]);
		if (!ticker || weight == null || weight <= 0) {
			continue;
		}

		holdings.push({
			ticker,
			name: name || null,
			weight: roundWeight(weight),
		});
	}
	return holdings;
}

export function roundhillEtfPageUrl(tickerInput: string): string {
	const ticker = normalizeTicker(tickerInput).toLowerCase();
	return `${ROUNDHILL_BASE_URL}${encodeURIComponent(ticker)}/`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Scrape Roundhill's browser-rendered official top holdings table. */
export async function scrapeRoundhillRenderedHoldings(
	tickerInput: string,
): Promise<OfficialEtfHoldingsSnapshot> {
	const ticker = normalizeTicker(tickerInput);
	if (!ticker) {
		return { holdings: [], source: null, error: "missing ETF ticker" };
	}

	const url = roundhillEtfPageUrl(ticker);
	let browser: PlaywrightBrowser | null = null;
	try {
		const playwright = (await import("playwright")) as PlaywrightRuntime;
		const chromium = playwright.chromium ?? playwright.default?.chromium;
		if (!chromium) {
			throw new Error("Playwright chromium runtime is unavailable");
		}

		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
		await page.waitForSelector(RENDERED_HOLDINGS_SELECTOR, { timeout: 30_000 });
		const rows = await page.$$eval<string[][]>(
			RENDERED_HOLDINGS_SELECTOR,
			(tableRows) =>
				tableRows.map((row: Element) =>
					Array.from(row.querySelectorAll("td")).map(
						(cell: Element) => cell.textContent?.trim() ?? "",
					),
				),
		);
		const holdings = parseRenderedRoundhillHoldingsRows(rows);
		return {
			holdings,
			source: holdings.length > 0 ? url : null,
			error: holdings.length > 0 ? null : "no rendered holdings rows found",
		};
	} catch (error) {
		return { holdings: [], source: url, error: errorMessage(error) };
	} finally {
		await browser?.close();
	}
}

export const roundhillOfficialEtfProvider: OfficialEtfHoldingsProvider = {
	issuer: "roundhill",
	priority: 100,
	matches(context) {
		const fundFamily = String(context.fundFamily ?? "").toLowerCase();
		const name = String(context.name ?? "").toLowerCase();
		return fundFamily.includes("roundhill") || name.includes("roundhill");
	},
	load(context) {
		return scrapeRoundhillRenderedHoldings(context.ticker);
	},
};
