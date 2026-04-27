/** Shared cache helpers for memory and persisted JSON cache layers. */

import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ZodType } from "zod";

import { loadJson, writeJson } from "./file-utils.js";

export type CacheEntry<T> = {
	value: T;
	updatedAt: Date;
};

/** Parse a cache timestamp into epoch milliseconds. */
export function parseCacheTimestamp(value: unknown): number | null {
	if (typeof value !== "string" || !value.trim()) {
		return null;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

/** Return whether a cache timestamp is inside the supplied freshness window. */
export function isCacheTimestampFresh(
	value: unknown,
	now: number | Date,
	maxAgeMs: number,
): boolean {
	const timestamp = parseCacheTimestamp(value);
	const nowMs = now instanceof Date ? now.getTime() : now;
	return timestamp != null && timestamp >= nowMs - maxAgeMs;
}

/** Load a JSON cache file and validate its shape before returning it. */
export async function loadJsonCache<T>(
	filePath: string,
	schema: ZodType<T>,
	createDefaultValue: () => T,
): Promise<T> {
	const payload = await loadJson<unknown>(filePath, null);
	const result = schema.safeParse(payload);
	return result.success ? result.data : createDefaultValue();
}

/** Write a JSON cache file, creating the parent directory if needed. */
export async function writeJsonCache(
	filePath: string,
	data: unknown,
	options?: { indent?: number },
): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeJson(filePath, data, options);
}

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
