/** Normalize ETF sector labels into dashboard display buckets. */

import { SECTOR_LABELS, SECTOR_PATTERN_RULES } from "../models/labels.js";
import type { EtfSector } from "./types.js";

/** Normalize sector labels into the stable display values used by the app. */
export function normalizeSectorName(value: string | null | undefined): string {
	const sectorText = String(value ?? "").trim();
	if (!sectorText) {
		return SECTOR_LABELS.other;
	}
	for (const label of Object.values(SECTOR_LABELS)) {
		if (sectorText.toLowerCase() === label.toLowerCase()) {
			return label;
		}
	}
	for (const [pattern, label] of SECTOR_PATTERN_RULES) {
		if (new RegExp(pattern, "i").test(sectorText)) {
			return label;
		}
	}
	return SECTOR_LABELS.other;
}

export function normalizeEtfSectors(
	sectors: Array<{ name: string | null | undefined; weight: number }>,
): EtfSector[] {
	const weightsBySector = new Map<string, number>();
	for (const sector of sectors) {
		if (!Number.isFinite(sector.weight)) {
			continue;
		}
		const name = normalizeSectorName(sector.name);
		weightsBySector.set(name, (weightsBySector.get(name) ?? 0) + sector.weight);
	}
	return [...weightsBySector.entries()].map(([name, weight]) => ({
		name,
		weight: Number(weight.toFixed(4)),
	}));
}
