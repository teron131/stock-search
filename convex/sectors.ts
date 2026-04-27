import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { SectorSnapshotMetaSchema, SectorSummarySchema } from "./schema";

type GenericRow = Record<string, unknown>;

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

export const get = query({
	args: { key: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const key = normalizeKey(args.key);
		const row = await ctx.db
			.query("sectors")
			.withIndex("by_key", (q) => q.eq("key", key))
			.unique();
		if (!row) {
			return null;
		}
		return {
			key: row.key,
			sectors: normalizeSectorRows(row.sectors),
			meta: row.meta,
			updatedAt: row.updatedAt,
		};
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
		const now = Date.now();
		const payload = {
			key,
			sectors: args.sectors,
			meta: args.meta,
			updatedAt: now,
		};
		const existing = await ctx.db
			.query("sectors")
			.withIndex("by_key", (q) => q.eq("key", key))
			.unique();

		if (existing) {
			const sectorsUnchanged =
				JSON.stringify(existing.sectors) === JSON.stringify(args.sectors);
			const metaUnchanged =
				JSON.stringify(existing.meta) === JSON.stringify(args.meta);
			if (!sectorsUnchanged || !metaUnchanged) {
				await ctx.db.patch(existing._id, payload);
			}
			return { ok: true, updated: true };
		}

		await ctx.db.insert("sectors", payload);
		return { ok: true, updated: false };
	},
});
