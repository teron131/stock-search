/** Shared cache helpers for memory and persisted JSON cache layers. */

import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ZodType } from "zod";

import { loadJson, writeJson } from "./file-utils.js";

export type CacheEntry<T> = {
	value: T;
	updatedAt: Date;
};

export type CacheFreshness = {
	timestamp: number | null;
	isFresh: boolean;
	isStale: boolean;
};

function cacheNowMs(now: number | Date): number {
	return now instanceof Date ? now.getTime() : now;
}

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
	return cacheFreshness(value, now, {
		freshWindowMs: maxAgeMs,
	}).isFresh;
}

/** Return fresh/stale state for an ISO timestamp and cache windows. */
export function cacheFreshness(
	value: unknown,
	now: number | Date,
	{
		freshWindowMs,
		staleWindowMs = freshWindowMs,
	}: {
		freshWindowMs: number;
		staleWindowMs?: number;
	},
): CacheFreshness {
	const timestamp = parseCacheTimestamp(value);
	return cacheFreshnessFromTimestamp(timestamp, now, {
		freshWindowMs,
		staleWindowMs,
	});
}

/** Return fresh/stale state for a parsed epoch-millisecond timestamp. */
export function cacheFreshnessFromTimestamp(
	timestamp: number | null,
	now: number | Date,
	{
		freshWindowMs,
		staleWindowMs = freshWindowMs,
	}: {
		freshWindowMs: number;
		staleWindowMs?: number;
	},
): CacheFreshness {
	if (timestamp == null) {
		return { timestamp: null, isFresh: false, isStale: false };
	}
	const nowMs = cacheNowMs(now);
	return {
		timestamp,
		isFresh: timestamp >= nowMs - freshWindowMs,
		isStale: timestamp >= nowMs - staleWindowMs,
	};
}

/** Return whether an in-memory cache entry is inside a freshness window. */
export function isCacheEntryFresh(
	updatedAt: Date,
	now: number | Date,
	maxAgeMs: number,
): boolean {
	return updatedAt.getTime() >= cacheNowMs(now) - maxAgeMs;
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

/** Small in-memory cache with a stale window. */
export class MemoryCache<T> {
	private readonly staleMs: number;
	private readonly entries = new Map<string, CacheEntry<T>>();

	constructor({ staleSeconds }: { staleSeconds: number }) {
		this.staleMs = staleSeconds * 1000;
	}

	private now(): Date {
		return new Date();
	}

	set(key: string, value: T, now = this.now()): void {
		this.entries.set(key, { value, updatedAt: now });
	}

	get(key: string, now = this.now()): T | null {
		const entry = this.entries.get(key);
		if (!entry) {
			return null;
		}
		if (!isCacheEntryFresh(entry.updatedAt, now, this.staleMs)) {
			return null;
		}
		return entry.value;
	}

	clear(): void {
		this.entries.clear();
	}
}
