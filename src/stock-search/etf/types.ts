/** Shared ETF snapshot and resolution types. */

import type { PositionRow } from "../api/data-store.js";

export type EtfHolding = {
	ticker: string;
	name: string | null;
	weight: number;
};

export type EtfSector = {
	name: string;
	weight: number;
};

export type EtfSnapshotResult = {
	holdings: EtfHolding[];
	sectors: EtfSector[];
	error: string | null;
};

export type EtfResolutionResult = {
	stockPositions: PositionRow[];
	etfPositions: PositionRow[];
	snapshotByTicker: Record<string, EtfSnapshotResult>;
	etfRefreshedCount: number;
	cacheChanged: boolean;
	changedTickers: string[];
};

export type EtfSnapshotCacheResult = {
	snapshot: EtfSnapshotResult;
	refreshedIndicators: Record<string, unknown> | null;
	didRefresh: boolean;
};
