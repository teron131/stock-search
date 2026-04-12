/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as meta_versions from "../meta_versions.js";
import type * as news from "../news.js";
import type * as portfolio from "../portfolio.js";
import type * as stock from "../stock.js";

import type {
	ApiFromModules,
	FilterApi,
	FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
	meta_versions: typeof meta_versions;
	news: typeof news;
	portfolio: typeof portfolio;
	stock: typeof stock;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
	typeof fullApi,
	FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
	typeof fullApi,
	FunctionReference<any, "internal">
>;

export declare const components: {};
