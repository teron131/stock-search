/** Tool registry shared by the Stock Search MCP server and CLI. */

import { readFile } from "node:fs/promises";

import { type ZodType, z } from "zod";

import { buildColorStandardsPayload } from "../api/color-standards.js";
import { appConfig } from "../api/config.js";
import { getSectorSnapshot } from "../data-sources/stockanalysis/index.js";
import {
	PortfolioNewsSummaryRequestSchema,
	PortfolioNewsSummaryWriteSchema,
	PortfolioNewsWriteSchema,
} from "../models/schemas.js";
import * as newsPipeline from "../news/pipeline.js";
import {
	buildPortfolioRawNewsBundle,
	loadPortfolioNews,
	loadPortfolioNewsSummary,
	savePortfolioNews,
	savePortfolioNewsSummary,
} from "../news/portfolio-news.js";
import { policy } from "../policy.js";
import {
	buildPortfolioPayload,
	loadEvalMap,
	loadStocksMap,
	patchPortfolioPosition,
	removePortfolioPosition,
} from "../portfolio/index.js";
import { getStore } from "../storage/index.js";
import {
	buildEvaluateTickerPayload,
	buildStandaloneTickerPayload,
} from "../ticker.js";

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

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

const StockNewsToolParametersSchema = z.object({
	ticker: z.string(),
	max_results: z.number().int().min(1).max(25).optional(),
});
const PortfolioRawNewsBundleParametersSchema = z.object({
	tickers: z.array(z.string()).min(1).max(50),
	n_days: z.number().int().min(1).max(7).optional(),
	max_results_per_ticker: z.number().int().min(1).max(25).optional(),
});
const PortfolioNewsKeySchema = z.object({
	key: z.string().optional(),
});

const EXTERNAL_PORTFOLIO_DEFAULT_SCOPE = "portfolio_live";
const PortfolioScopeSchema = z
	.enum(policy.request.portfolioScopeValues)
	.default(EXTERNAL_PORTFOLIO_DEFAULT_SCOPE);
const TickerSourceSchema = z.enum(policy.request.tickerSourceValues).optional();
const NoArgsSchema = z.object({});

export function toolHasParameters(parameters?: ZodType): parameters is ZodType {
	return Boolean(parameters && parameters !== NoArgsSchema);
}

function asJsonValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value, null, 0)) as JsonValue;
}

function realtimeConfigPayload(): Record<string, unknown> {
	return {
		provider: "none",
		enabled: false,
		topics: [],
	};
}

async function loadDashboardHtml(): Promise<string> {
	return readFile(appConfig.indexFile, "utf8");
}

function redirectToolError(): never {
	throw new Error("HTTP error 307: Temporary Redirect");
}

async function callStockNewsTool(
	args: Record<string, unknown>,
	fetchNews: (
		ticker: string,
		options: { maxResults?: number; resolveIdentity?: boolean },
	) => Promise<unknown>,
): Promise<unknown> {
	const { ticker, max_results } = StockNewsToolParametersSchema.parse(args);
	return fetchNews(ticker, {
		maxResults: max_results,
		resolveIdentity: true,
	});
}

export const stockSearchTools: readonly StockSearchTool[] = [
	{
		name: "serve_dashboard_calendar_get",
		description: "Serve client-side dashboard routes.",
		parameters: NoArgsSchema,
		execute: async () => loadDashboardHtml(),
	},
	{
		name: "serve_dashboard_marketmap_get",
		description: "Serve client-side dashboard routes.",
		parameters: NoArgsSchema,
		execute: async () => loadDashboardHtml(),
	},
	{
		name: "serve_dashboard_sectors_get",
		description: "Serve client-side dashboard routes.",
		parameters: NoArgsSchema,
		execute: async () => loadDashboardHtml(),
	},
	{
		name: "serve_dashboard_dashboard_get",
		description: "Serve client-side dashboard routes.",
		parameters: NoArgsSchema,
		execute: async () => loadDashboardHtml(),
	},
	{
		name: "auth_login_auth_login_get",
		description: "Start the Google OAuth flow when auth is enabled.",
		parameters: NoArgsSchema,
		execute: async () => redirectToolError(),
	},
	{
		name: "auth_callback_auth_callback_get",
		description: "Complete the Google OAuth flow and create the session.",
		parameters: NoArgsSchema,
		execute: async () => redirectToolError(),
	},
	{
		name: "auth_logout_auth_logout_post",
		description: "Clear the authenticated session.",
		parameters: NoArgsSchema,
		execute: async () => redirectToolError(),
	},
	{
		name: "auth_logout_auth_logout_post_2",
		description: "Clear the authenticated session.",
		parameters: NoArgsSchema,
		execute: async () => redirectToolError(),
	},
	{
		name: "auth_session_auth_session_get",
		description: "Return the current auth/session status for the UI.",
		parameters: NoArgsSchema,
		execute: async () => ({
			enabled: appConfig.authEnabled,
			authenticated: false,
			email: null,
		}),
	},
	{
		name: "get_portfolio",
		description:
			"Return the current portfolio payload. Defaults to a live held-portfolio refresh for external callers.",
		parameters: z.object({
			scope: PortfolioScopeSchema,
		}),
		execute: async ({ scope }) =>
			buildPortfolioPayload(
				getStore(),
				policy.request.portfolioScopeValue(scope),
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
			source: TickerSourceSchema,
		}),
		execute: async ({ ticker, source }) =>
			buildStandaloneTickerPayload(
				getStore(),
				String(ticker ?? ""),
				policy.request.tickerSource(source),
			),
	},
	{
		name: "get_eval_map",
		description: "Return the normalized evaluation map.",
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
		name: "sectors_api_sectors_get",
		description: "Return the current StockAnalysis sector snapshot.",
		parameters: NoArgsSchema,
		execute: async () => getSectorSnapshot(getStore()),
	},
	{
		name: "get_color_standards",
		description: "Return the dashboard color scale definitions.",
		parameters: NoArgsSchema,
		execute: async () => buildColorStandardsPayload(),
	},
	{
		name: "get_realtime_config",
		description: "Return the realtime polling configuration.",
		parameters: NoArgsSchema,
		execute: async () => realtimeConfigPayload(),
	},
	{
		name: "get_stock_news",
		description:
			"Compatibility alias for raw-fast ticker news. Does not run LLM analysis.",
		parameters: StockNewsToolParametersSchema,
		execute: async (args) =>
			callStockNewsTool(args, newsPipeline.getRawFastNewsAsync),
	},
	{
		name: "get_stock_news_raw_fast",
		description:
			"Return capped raw provider news plus optional webloaded excerpts. No LLM analysis; faster and noisier.",
		parameters: StockNewsToolParametersSchema,
		execute: async (args) =>
			callStockNewsTool(args, newsPipeline.getRawFastNewsAsync),
	},
	{
		name: "get_stock_news_analyzed_slow",
		description:
			"Return LLM-analyzed ticker news with relevance, category, sentiment, and ticker-specific summaries. Slower and costlier.",
		parameters: StockNewsToolParametersSchema,
		execute: async (args) =>
			callStockNewsTool(args, newsPipeline.getAnalyzedSlowNewsAsync),
	},
	{
		name: "get_portfolio_news_raw_fast",
		description:
			"Return controlled raw-fast news bundles for portfolio tickers. Includes capped webloaded excerpts and no LLM analysis.",
		parameters: PortfolioRawNewsBundleParametersSchema,
		execute: async (args) => {
			const { tickers, n_days, max_results_per_ticker } =
				PortfolioRawNewsBundleParametersSchema.parse(args);
			return buildPortfolioRawNewsBundle({
				tickers,
				nDays: n_days,
				maxResultsPerTicker: max_results_per_ticker,
				newsOptions: { resolveIdentity: true },
			});
		},
	},
	{
		name: "get_portfolio_news",
		description:
			"Return the latest persisted portfolio news articles and summary from the shared DB.",
		parameters: PortfolioNewsKeySchema,
		execute: async (args) => {
			const { key } = PortfolioNewsKeySchema.parse(args);
			return loadPortfolioNews(getStore(), key);
		},
	},
	{
		name: "save_portfolio_news",
		description:
			"Persist externally produced ticker news summaries into the shared DB. System fields are filled automatically.",
		parameters: PortfolioNewsWriteSchema,
		execute: async (args) =>
			savePortfolioNews(getStore(), PortfolioNewsWriteSchema.parse(args)),
	},
	{
		name: "get_portfolio_news_summary",
		description:
			"Return the latest persisted portfolio-level news summary from the shared DB.",
		parameters: PortfolioNewsKeySchema,
		execute: async (args) => {
			const { key } = PortfolioNewsKeySchema.parse(args);
			return loadPortfolioNewsSummary(getStore(), key);
		},
	},
	{
		name: "save_portfolio_news_summary",
		description:
			"Persist an externally produced portfolio-level news summary into the shared DB, preserving ticker summaries and system fields.",
		parameters: PortfolioNewsSummaryWriteSchema,
		execute: async (args) =>
			savePortfolioNewsSummary(
				getStore(),
				PortfolioNewsSummaryWriteSchema.parse(args),
			),
	},
	{
		name: "summarize_portfolio_news",
		description:
			"Build a structured portfolio-level news summary from provided rows and article summaries. Does not write to the DB.",
		parameters: PortfolioNewsSummaryRequestSchema,
		execute: async ({ rows, items }) =>
			newsPipeline.buildPortfolioNewsSummary(
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
					? (z.toJSONSchema(parameters) as Record<string, unknown>)
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
