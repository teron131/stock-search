/** Tool registry shared by the Stock Search MCP server and CLI. */

import { readFile } from "node:fs/promises";

import { toJsonSchema } from "xsschema";
import { z, type ZodType } from "zod";

import { buildColorStandardsPayload } from "../api/color-standards.js";
import { getStore, convexRealtimeTopics } from "../api/data-store.js";
import { appConfig } from "../api/config.js";
import {
	buildEvaluateTickerPayload,
	buildStandaloneTickerPayload,
} from "../api/ticker-standalone.js";
import { getIndustrySnapshot } from "../data-sources/stockanalysis/index.js";
import { portfolioNewsSummaryRequestSchema } from "../models/schemas.js";
import * as newsOrchestrator from "../news/orchestrator.js";
import {
	buildPortfolioPayload,
	loadEvalMap,
	loadStocksMap,
	patchPortfolioPosition,
	removePortfolioPosition,
} from "../portfolio.js";

export type JsonScalar = string | number | boolean | null;
export type JsonValue =
	| JsonScalar
	| JsonValue[]
	| { [key: string]: JsonValue };

export type OpenApiTool = {
	name: string;
	description: string;
	parameters?: Record<string, unknown>;
};

export type ToolCallResult = {
	structuredContent: JsonValue;
	content: Array<{
		type: "text";
		text: string;
	}>;
};

export type StockSearchTool = {
	name: string;
	description: string;
	parameters?: ZodType;
	execute: (args: Record<string, unknown>) => Promise<unknown>;
};

const portfolioScopeSchema = z
	.enum(["priority", "all_cached", "portfolio_live", "all"])
	.optional();
const tickerSourceSchema = z.enum(["auto", "live", "cache"]).optional();
const noArgsSchema = z.object({});

export function toolHasParameters(parameters?: ZodType): parameters is ZodType {
	return Boolean(parameters && parameters !== noArgsSchema);
}

function asJsonValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value, null, 0)) as JsonValue;
}

function realtimeConfigPayload(): Record<string, unknown> {
	return {
		provider: "convex",
		enabled: Boolean(appConfig.convexSyncEnabled && appConfig.convexUrl),
		convex_url: appConfig.convexUrl || null,
		audience: appConfig.convexAudience || null,
		topics: [...convexRealtimeTopics],
	};
}

async function loadDashboardHtml(): Promise<string> {
	return readFile(appConfig.indexFile, "utf8");
}

function redirectToolError(): never {
	throw new Error("HTTP error 307: Temporary Redirect");
}

export const stockSearchTools: readonly StockSearchTool[] = [
	{
		name: "serve_dashboard_calendar_get",
		description: "Serve client-side dashboard routes.",
		parameters: noArgsSchema,
		execute: async () => loadDashboardHtml(),
	},
	{
		name: "serve_dashboard_marketmap_get",
		description: "Serve client-side dashboard routes.",
		parameters: noArgsSchema,
		execute: async () => loadDashboardHtml(),
	},
	{
		name: "serve_dashboard_industry_get",
		description: "Serve client-side dashboard routes.",
		parameters: noArgsSchema,
		execute: async () => loadDashboardHtml(),
	},
	{
		name: "serve_dashboard_dashboard_get",
		description: "Serve client-side dashboard routes.",
		parameters: noArgsSchema,
		execute: async () => loadDashboardHtml(),
	},
	{
		name: "auth_login_auth_login_get",
		description: "Start the Google OAuth flow when auth is enabled.",
		parameters: noArgsSchema,
		execute: async () => redirectToolError(),
	},
	{
		name: "auth_callback_auth_callback_get",
		description: "Complete the Google OAuth flow and create the session.",
		parameters: noArgsSchema,
		execute: async () => redirectToolError(),
	},
	{
		name: "auth_logout_auth_logout_post",
		description: "Clear the authenticated session.",
		parameters: noArgsSchema,
		execute: async () => redirectToolError(),
	},
	{
		name: "auth_logout_auth_logout_post_2",
		description: "Clear the authenticated session.",
		parameters: noArgsSchema,
		execute: async () => redirectToolError(),
	},
	{
		name: "auth_session_auth_session_get",
		description: "Return the current auth/session status for the UI.",
		parameters: noArgsSchema,
		execute: async () => ({
			enabled: appConfig.authEnabled,
			authenticated: false,
			email: null,
		}),
	},
	{
		name: "get_portfolio",
		description: "Return the current portfolio payload.",
		parameters: z.object({
			scope: portfolioScopeSchema,
		}),
		execute: async ({ scope }) =>
			buildPortfolioPayload(
				getStore(),
				(typeof scope === "string" ? scope : "all") as
					| "priority"
					| "all_cached"
					| "portfolio_live"
					| "all",
			),
	},
	{
		name: "upsert_portfolio_position",
		description: "Create or update one portfolio position.",
		parameters: z.object({
			ticker: z.string(),
			quantity: z.number().optional(),
			strategy: z.string().nullable().optional(),
		}),
		execute: async ({ ticker, quantity, strategy }) =>
			patchPortfolioPosition(getStore(), String(ticker ?? ""), {
				quantity: typeof quantity === "number" ? quantity : undefined,
				strategy:
					typeof strategy === "string" || strategy === null
						? strategy
						: undefined,
			}),
	},
	{
		name: "remove_portfolio_position",
		description: "Delete one portfolio position.",
		parameters: z.object({
			ticker: z.string(),
		}),
		execute: async ({ ticker }) =>
			removePortfolioPosition(getStore(), String(ticker ?? "")),
	},
	{
		name: "get_stock_stats",
		description: "Return standalone stats for one ticker.",
		parameters: z.object({
			ticker: z.string(),
			source: tickerSourceSchema,
		}),
		execute: async ({ ticker, source }) =>
			buildStandaloneTickerPayload(
				getStore(),
				String(ticker ?? ""),
				(typeof source === "string" ? source : "auto") as
					| "auto"
					| "live"
					| "cache",
			),
	},
	{
		name: "get_eval_map",
		description: "Return the stored evaluation map.",
		parameters: z.object({
			tickers: z.array(z.string()).optional(),
		}),
		execute: async ({ tickers }) =>
			loadEvalMap(getStore(), Array.isArray(tickers) ? tickers : undefined),
	},
	{
		name: "get_stock_map",
		description: "Return the stored stock indicator map.",
		parameters: z.object({
			tickers: z.array(z.string()).optional(),
		}),
		execute: async ({ tickers }) =>
			loadStocksMap(getStore(), Array.isArray(tickers) ? tickers : undefined),
	},
	{
		name: "industries_api_industries_get",
		description: "Return the current StockAnalysis industry snapshot.",
		parameters: noArgsSchema,
		execute: async () => getIndustrySnapshot(),
	},
	{
		name: "get_color_standards",
		description: "Return the dashboard color scale definitions.",
		parameters: noArgsSchema,
		execute: async () => buildColorStandardsPayload(),
	},
	{
		name: "get_realtime_config",
		description: "Return the realtime polling configuration.",
		parameters: noArgsSchema,
		execute: async () => realtimeConfigPayload(),
	},
	{
		name: "get_stock_news",
		description: "Return recent news articles for a ticker.",
		parameters: z.object({
			ticker: z.string(),
		}),
		execute: async ({ ticker }) =>
			newsOrchestrator.getNewsAsync(String(ticker ?? "")),
	},
	{
		name: "portfolio_news_summary_api_portfolio_news_summary_post",
		description:
			"Return a structured portfolio-level summary from merged article summaries.",
		parameters: portfolioNewsSummaryRequestSchema,
		execute: async ({ rows, items }) =>
			newsOrchestrator.buildPortfolioNewsSummary(
				Array.isArray(rows) ? rows : [],
				Array.isArray(items) ? items : [],
			),
	},
	{
		name: "evaluate_stock",
		description: "Return the evaluation payload for a ticker.",
		parameters: z.object({
			ticker: z.string(),
		}),
		execute: async ({ ticker }) =>
			buildEvaluateTickerPayload(getStore(), String(ticker ?? "")),
	},
];

export function commandName(toolName: string): string {
	return toolName.replaceAll("_", "-");
}

export function getToolByName(name: string): StockSearchTool | undefined {
	return stockSearchTools.find((tool) => tool.name === name);
}

export async function listTools(): Promise<OpenApiTool[]> {
	return Promise.all(
		stockSearchTools.map(async (tool) => {
			const parameters = tool.parameters;
			return {
				name: tool.name,
				description: tool.description,
				parameters: toolHasParameters(parameters)
					? ((await toJsonSchema(parameters)) as Record<string, unknown>)
					: undefined,
			};
		}),
	);
}

export async function callTool(
	toolName: string,
	arguments_: Record<string, unknown>,
): Promise<ToolCallResult> {
	const tool = getToolByName(toolName);
	if (!tool) {
		throw new Error(`Unknown tool: ${toolName}`);
	}

	const parsedArguments = tool.parameters
		? tool.parameters.parse(arguments_)
		: {};
	const result = await tool.execute(parsedArguments as Record<string, unknown>);
	if (typeof result === "string") {
		return {
			structuredContent: null,
			content: [
				{
					type: "text",
					text: result,
				},
			],
		};
	}

	const structuredContent = asJsonValue(result);
	return {
		structuredContent,
		content: [
			{
				type: "text",
				text: JSON.stringify(structuredContent),
			},
		],
	};
}
