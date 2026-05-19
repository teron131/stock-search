/** Finviz quote-page source for cached slow fundamental stats. */

import { parseFinvizQuoteSnapshot } from "./parsing.js";
import type { FinvizQuoteSnapshot } from "./schemas.js";

const FINVIZ_BATCH_SIZE = 2;
const FINVIZ_BATCH_GAP_MIN_MS = 3_000;
const FINVIZ_BATCH_GAP_MAX_MS = 5_000;
const FINVIZ_RATE_LIMIT_COOLDOWN_MS = 3_600_000;

type FinvizQueueItem<T> = {
	task: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

class FinvizRateLimitError extends Error {
	constructor() {
		super("Finviz quote requests are temporarily rate limited");
		this.name = "FinvizRateLimitError";
	}
}

function normalizeTicker(ticker: string): string {
	return ticker.toUpperCase().trim();
}

function randomBatchGapMs(): number {
	return (
		FINVIZ_BATCH_GAP_MIN_MS +
		Math.floor(
			Math.random() * (FINVIZ_BATCH_GAP_MAX_MS - FINVIZ_BATCH_GAP_MIN_MS + 1),
		)
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialize Finviz quote-page fetches into small jittered batches. */
class FinvizRequestQueue {
	private cooldownUntil = 0;
	private queue: Array<FinvizQueueItem<unknown>> = [];
	private running = false;

	async schedule<T>(task: () => Promise<T>): Promise<T> {
		if (this.isCoolingDown()) {
			throw new FinvizRateLimitError();
		}

		return new Promise<T>((resolve, reject) => {
			this.queue.push({
				task: task as () => Promise<unknown>,
				resolve: resolve as (value: unknown) => void,
				reject,
			});
			void this.drain();
		});
	}

	private async drain(): Promise<void> {
		if (this.running) {
			return;
		}
		this.running = true;
		try {
			while (this.queue.length > 0) {
				if (this.isCoolingDown()) {
					this.rejectPending(new FinvizRateLimitError());
					return;
				}

				const rateLimited = await this.runNextBatch();
				if (rateLimited) {
					this.rejectPending(this.noteRateLimit());
					return;
				}
				if (this.queue.length > 0) {
					await sleep(randomBatchGapMs());
				}
			}
		} finally {
			this.running = false;
		}
	}

	private isCoolingDown(): boolean {
		return Date.now() < this.cooldownUntil;
	}

	private noteRateLimit(): FinvizRateLimitError {
		this.cooldownUntil = Date.now() + FINVIZ_RATE_LIMIT_COOLDOWN_MS;
		return new FinvizRateLimitError();
	}

	private rejectPending(error: unknown): void {
		const pending = this.queue;
		this.queue = [];
		for (const item of pending) {
			item.reject(error);
		}
	}

	private async runNextBatch(): Promise<boolean> {
		const batch = this.queue.splice(0, FINVIZ_BATCH_SIZE);
		const results = await Promise.allSettled(batch.map((item) => item.task()));
		let rateLimited = false;

		for (const [index, result] of results.entries()) {
			const item = batch[index];
			if (!item) {
				continue;
			}
			if (result.status === "fulfilled") {
				item.resolve(result.value);
				continue;
			}
			if (result.reason instanceof FinvizRateLimitError) {
				rateLimited = true;
			}
			item.reject(result.reason);
		}

		return rateLimited;
	}
}

const finvizRequestQueue = new FinvizRequestQueue();

export function finvizQuoteUrl(ticker: string): string {
	return `https://finviz.com/quote.ashx?t=${encodeURIComponent(normalizeTicker(ticker))}&p=d`;
}

export class FinvizSource {
	private snapshotPromise: Promise<FinvizQuoteSnapshot> | null = null;

	private readonly ticker: string;

	constructor(ticker: string) {
		this.ticker = normalizeTicker(ticker);
	}

	/** Fetch and parse the Finviz quote snapshot once per source instance. */
	async getQuoteSnapshot(): Promise<FinvizQuoteSnapshot> {
		this.snapshotPromise ??= this.loadQuoteSnapshot();
		return this.snapshotPromise;
	}

	private async loadQuoteSnapshot(): Promise<FinvizQuoteSnapshot> {
		return finvizRequestQueue.schedule(() => this.fetchQuoteSnapshot());
	}

	private async fetchQuoteSnapshot(): Promise<FinvizQuoteSnapshot> {
		const url = finvizQuoteUrl(this.ticker);
		const response = await fetch(url, {
			headers: {
				"user-agent": "Mozilla/5.0",
			},
		});
		if (response.status === 429) {
			throw new FinvizRateLimitError();
		}
		if (!response.ok) {
			throw new Error(`Finviz quote page unavailable for ${this.ticker}`);
		}

		const html = await response.text();
		const snapshot = parseFinvizQuoteSnapshot(
			html,
			this.ticker,
			url,
			new Date().toISOString(),
		);
		if (Object.keys(snapshot.raw).length === 0) {
			throw new Error(`Finviz quote snapshot missing for ${this.ticker}`);
		}
		return snapshot;
	}

	/** Return app-facing slow statistics from the Finviz quote snapshot. */
	async getStatisticsSnapshot(): Promise<Record<string, unknown>> {
		const snapshot = await this.getQuoteSnapshot();
		return {
			market_cap: snapshot.market_cap,
			pe: snapshot.pe,
			pe_forward: snapshot.pe_forward,
			ps: snapshot.ps,
			peg: snapshot.peg,
			beta: snapshot.beta,
			rsi: snapshot.rsi,
			roe: snapshot.roe,
			roic: snapshot.roic,
			gross_margin: snapshot.gross_margin,
			operating_margin: snapshot.operating_margin,
			debt_to_equity: snapshot.debt_to_equity,
			eps_this_y_growth: snapshot.eps_this_y_growth,
			eps_next_y_growth: snapshot.eps_next_y_growth,
			eps_next_5y_growth: snapshot.eps_next_5y_growth,
			eps_past_3y_growth: snapshot.eps_past_3y_growth,
			eps_past_5y_growth: snapshot.eps_past_5y_growth,
			sales_past_3y_growth: snapshot.sales_past_3y_growth,
			sales_past_5y_growth: snapshot.sales_past_5y_growth,
			eps_yoy_ttm_growth: snapshot.eps_yoy_ttm_growth,
		};
	}
}
