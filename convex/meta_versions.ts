import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const get = query({
	args: { key: v.string() },
	handler: async (ctx, args) => {
		const entry = await ctx.db
			.query("meta_versions")
			.withIndex("by_key", (q) => q.eq("key", args.key))
			.unique();
		if (!entry) {
			return null;
		}
		return {
			key: entry.key,
			value: entry.value,
			updatedAt: entry.updatedAt,
		};
	},
});

export const set = mutation({
	args: {
		key: v.string(),
		value: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("meta_versions")
			.withIndex("by_key", (q) => q.eq("key", args.key))
			.unique();
		const now = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, {
				value: args.value,
				updatedAt: now,
			});
			return { ok: true, updated: true };
		}
		await ctx.db.insert("meta_versions", {
			key: args.key,
			value: args.value,
			updatedAt: now,
		});
		return { ok: true, updated: false };
	},
});
