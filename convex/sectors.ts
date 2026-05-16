import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { changedFields } from "./flat_diff";
import { SectorSnapshotMetaSchema, SectorSummarySchema } from "./schema";

type GenericRow = Record<string, unknown>;
type SectorDocument = Doc<"sectors">;
type SectorPayload = Omit<SectorDocument, "_creationTime" | "_id">;

function normalizeKey(value: string | undefined): string {
	return (value ?? "").trim() || "default";
}

function normalizeSectorRows(value: unknown): Array<GenericRow> {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((sector) => typeof sector === "object" && sector !== null)
		.map((sector) => sector as GenericRow);
}

function normalizeTopTickers(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((ticker) => (typeof ticker === "string" ? ticker.trim() : ""))
		.filter(Boolean)
		.slice(0, 5);
}

function numberOrNull(value: unknown): number | null {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function sectorFromRow(row: SectorDocument): GenericRow | null {
	if (!row.sector) {
		return null;
	}
	return {
		sector: row.sector,
		top_tickers: [
			row.top_ticker_1,
			row.top_ticker_2,
			row.top_ticker_3,
			row.top_ticker_4,
			row.top_ticker_5,
		].filter(
			(ticker): ticker is string => typeof ticker === "string" && !!ticker,
		),
		stock_count: row.stock_count ?? 0,
		market_cap: row.market_cap ?? null,
		pe: row.pe ?? null,
		profit_margin: row.profit_margin ?? null,
		change_percent_1d: row.change_percent_1d ?? null,
		change_percent_1y: row.change_percent_1y ?? null,
	};
}

function sectorPayload(
	key: string,
	sector: GenericRow,
	meta: GenericRow,
	sortIndex: number,
	now: number,
): SectorPayload {
	const topTickers = normalizeTopTickers(sector.top_tickers);
	return {
		key,
		sector: String(sector.sector ?? "").trim(),
		sort_index: sortIndex,
		top_ticker_1: topTickers[0] ?? null,
		top_ticker_2: topTickers[1] ?? null,
		top_ticker_3: topTickers[2] ?? null,
		top_ticker_4: topTickers[3] ?? null,
		top_ticker_5: topTickers[4] ?? null,
		stock_count: Number(sector.stock_count) || 0,
		market_cap: numberOrNull(sector.market_cap),
		pe: numberOrNull(sector.pe),
		profit_margin: numberOrNull(sector.profit_margin),
		change_percent_1d: numberOrNull(sector.change_percent_1d),
		change_percent_1y: numberOrNull(sector.change_percent_1y),
		meta_source: typeof meta.source === "string" ? meta.source : null,
		meta_fetched_at:
			typeof meta.fetched_at === "string" ? meta.fetched_at : null,
		meta_sector_count: Number(meta.sector_count) || null,
		updatedAt: now,
	};
}

async function replaceSectorRows(
	ctx: MutationCtx,
	key: string,
	sectors: GenericRow[],
	meta: GenericRow,
	now: number,
): Promise<void> {
	const rows = await ctx.db
		.query("sectors")
		.withIndex("by_key", (q) => q.eq("key", key))
		.collect();
	const existingBySector = new Map(
		rows.filter((row) => row.sector).map((row) => [String(row.sector), row]),
	);
	const nextSectors = new Set<string>();

	for (const [index, sector] of sectors.entries()) {
		const sectorName = String(sector.sector ?? "").trim();
		if (!sectorName) {
			continue;
		}
		nextSectors.add(sectorName);
		const payload = sectorPayload(key, sector, meta, index, now);
		const existing = existingBySector.get(sectorName);
		if (existing) {
			const patch = changedFields(existing as GenericRow, payload);
			if (patch) {
				await ctx.db.patch(existing._id, patch);
			}
		} else {
			await ctx.db.insert("sectors", payload);
		}
	}

	for (const row of rows) {
		if (!row.sector || !nextSectors.has(row.sector)) {
			await ctx.db.delete(row._id);
		}
	}
}

export const get = query({
	args: { key: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const key = normalizeKey(args.key);
		const rows = await ctx.db
			.query("sectors")
			.withIndex("by_key", (q) => q.eq("key", key))
			.collect();
		const sectors = rows
			.filter((row) => row.sector)
			.sort(
				(a, b) =>
					(a.sort_index ?? 0) - (b.sort_index ?? 0) ||
					String(a.sector).localeCompare(String(b.sector)),
			)
			.map(sectorFromRow)
			.filter((sector): sector is GenericRow => sector !== null);
		if (sectors.length > 0) {
			const metaRow = rows[0];
			return {
				key,
				sectors,
				meta: {
					source: metaRow?.meta_source ?? "",
					fetched_at: metaRow?.meta_fetched_at ?? null,
					sector_count: metaRow?.meta_sector_count ?? sectors.length,
				},
				updatedAt: rows.reduce(
					(maxUpdatedAt, row) => Math.max(maxUpdatedAt, row.updatedAt ?? 0),
					0,
				),
			};
		}
		return null;
	},
});

export const set = mutation({
	args: {
		key: v.optional(v.string()),
		sectors: v.array(SectorSummarySchema),
		meta: SectorSnapshotMetaSchema,
	},
	handler: async (ctx, args) => {
		const key = normalizeKey(args.key);
		await replaceSectorRows(
			ctx,
			key,
			normalizeSectorRows(args.sectors),
			args.meta,
			Date.now(),
		);
		return { ok: true, updated: true };
	},
});
