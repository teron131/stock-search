/** Provide a small tiered cache with stale and failure windows. */

export type CacheEntry<T> = {
	value: T;
	updatedAt: Date;
};

/** Thread-safe-enough cache with fresh/stale windows and failure cooldown. */
export class TieredCache<T> {
	private readonly ttlMs: number;
	private readonly staleMs: number;
	private readonly failureCooldownMs: number;
	private readonly entries = new Map<string, CacheEntry<T>>();
	private readonly failures = new Map<string, Date>();

	constructor({
		ttlSeconds,
		staleSeconds,
		failureCooldownSeconds,
	}: {
		ttlSeconds: number;
		staleSeconds: number;
		failureCooldownSeconds: number;
	}) {
		this.ttlMs = ttlSeconds * 1000;
		this.staleMs = staleSeconds * 1000;
		this.failureCooldownMs = failureCooldownSeconds * 1000;
	}

	private now(): Date {
		return new Date();
	}

	getEntry(key: string): CacheEntry<T> | null {
		return this.entries.get(key) ?? null;
	}

	set(key: string, value: T, now = this.now()): void {
		this.entries.set(key, { value, updatedAt: now });
		this.failures.delete(key);
	}

	markFailure(key: string, now = this.now()): void {
		this.failures.set(key, now);
	}

	shouldRetry(key: string, now = this.now()): boolean {
		const failureAt = this.failures.get(key);
		if (!failureAt) {
			return true;
		}
		return now.getTime() - failureAt.getTime() > this.failureCooldownMs;
	}

	getFresh(key: string, now = this.now()): T | null {
		const entry = this.entries.get(key);
		if (!entry) {
			return null;
		}
		if (now.getTime() - entry.updatedAt.getTime() > this.ttlMs) {
			return null;
		}
		return entry.value;
	}

	getStale(key: string, now = this.now()): T | null {
		const entry = this.entries.get(key);
		if (!entry) {
			return null;
		}
		if (now.getTime() - entry.updatedAt.getTime() > this.staleMs) {
			return null;
		}
		return entry.value;
	}

	clear(): void {
		this.entries.clear();
		this.failures.clear();
	}
}
