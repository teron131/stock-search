/** CLI for calling the Stock Search MCP tools in-process. */

import type { JsonValue, OpenApiTool } from "./mcp/tools.js";
import { INDICATOR_FIELD_GROUPS } from "./models/field-definitions.js";
import {
	isTickerSource,
	TICKER_SOURCE_VALUES,
	type TickerSource,
} from "./policy.js";

type CliCommand = {
	command: string;
	toolName: string;
	description: string;
};

export const CLI_COMMANDS: readonly CliCommand[] = [
	{
		command: "stocks",
		toolName: "get_stock_stats",
		description: "Return flattened stats for one or many tickers.",
	},
	{
		command: "sectors",
		toolName: "sectors_api_sectors_get",
		description: "Return the current StockAnalysis sector snapshot.",
	},
	{
		command: "news",
		toolName: "get_stock_news",
		description: "Return recent news articles for a ticker.",
	},
	{
		command: "evaluate",
		toolName: "evaluate_stock",
		description: "Return the evaluation payload for a ticker.",
	},
];

const STOCK_STATS_FIELDS: readonly string[] = [
	"ticker",
	...Object.values(INDICATOR_FIELD_GROUPS)
		.flatMap((group) => group.fields)
		.filter((field) => field !== "change"),
];

function parseBool(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "t", "yes", "y", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "f", "no", "n", "off"].includes(normalized)) {
		return false;
	}
	throw new Error(`Invalid boolean value: ${value}`);
}

function normalizeSchema(
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : null;
	if (!anyOf) {
		return schema;
	}

	const nonNullOptions = anyOf.filter(
		(option) =>
			typeof option === "object" &&
			option !== null &&
			(option as Record<string, unknown>).type !== "null",
	);
	if (nonNullOptions.length !== 1) {
		return schema;
	}

	const normalized = {
		...(nonNullOptions[0] as Record<string, unknown>),
	};
	for (const key of ["title", "description", "default", "enum"]) {
		if (schema[key] !== undefined && normalized[key] === undefined) {
			normalized[key] = schema[key];
		}
	}
	return normalized;
}

function jsonArgument(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new Error(
			`Invalid JSON value: ${value}${error instanceof Error ? ` (${error.message})` : ""}`,
		);
	}
}

function arrayArgument(value: string): unknown[] {
	const trimmed = value.trim();
	if (trimmed.startsWith("[")) {
		const parsed = jsonArgument(trimmed);
		if (!Array.isArray(parsed)) {
			throw new Error(`Expected a JSON array: ${value}`);
		}
		return parsed;
	}
	return trimmed
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function asJsonValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value, null, 0)) as JsonValue;
}

function parseArgumentValue(
	parameterSchema: Record<string, unknown>,
	value: string,
): unknown {
	const normalized = normalizeSchema(parameterSchema);
	const schemaType = normalized.type;
	if (schemaType === "integer" || schemaType === "number") {
		return Number(value);
	}
	if (schemaType === "boolean") {
		return parseBool(value);
	}
	if (schemaType === "array") {
		return arrayArgument(value);
	}
	if (schemaType === "object") {
		return jsonArgument(value);
	}
	return value;
}

export function resolveCliToolName(command: string): string | undefined {
	const cliCommand = CLI_COMMANDS.find((item) => item.command === command);
	return cliCommand?.toolName;
}

function printCommandList(): void {
	for (const cliCommand of CLI_COMMANDS) {
		console.log(`${cliCommand.command}\t${cliCommand.description}`);
	}
}

function parseToolArguments(
	tool: OpenApiTool,
	argv: string[],
): { pretty: boolean; arguments: Record<string, unknown> } {
	const pretty = argv.includes("--pretty");
	const parameters =
		tool.parameters && typeof tool.parameters === "object"
			? tool.parameters
			: {};
	const properties =
		parameters.properties && typeof parameters.properties === "object"
			? (parameters.properties as Record<string, Record<string, unknown>>)
			: {};
	const requiredNames = new Set(
		Array.isArray(parameters.required)
			? parameters.required.map((value) => String(value))
			: [],
	);

	const values: Record<string, unknown> = {};
	const remainingPositionals: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token || token === "--pretty") {
			continue;
		}
		if (token.startsWith("--")) {
			const parameterName = token.slice(2).replaceAll("-", "_");
			const parameterSchema = properties[parameterName];
			if (!parameterSchema) {
				throw new Error(`Unknown option for ${tool.name}: ${token}`);
			}
			const normalizedSchema = normalizeSchema(parameterSchema);
			if (normalizedSchema.type === "boolean") {
				values[parameterName] = true;
				continue;
			}
			const nextValue = argv[index + 1];
			if (nextValue == null) {
				throw new Error(`Missing value for option: ${token}`);
			}
			values[parameterName] = parseArgumentValue(parameterSchema, nextValue);
			index += 1;
			continue;
		}
		remainingPositionals.push(token);
	}

	const orderedRequiredNames = Object.keys(properties).filter((name) =>
		requiredNames.has(name),
	);
	orderedRequiredNames.forEach((parameterName, index) => {
		const rawValue = remainingPositionals[index];
		if (rawValue == null) {
			throw new Error(`Missing required argument: ${parameterName}`);
		}
		values[parameterName] = parseArgumentValue(
			properties[parameterName],
			rawValue,
		);
	});

	const unusedPositionals = remainingPositionals.slice(
		orderedRequiredNames.length,
	);
	if (
		unusedPositionals.length > 0 &&
		values.tickers === undefined &&
		properties.tickers
	) {
		values.tickers = unusedPositionals;
	}

	return {
		pretty,
		arguments: values,
	};
}

function stockStatsPayload(row: JsonValue): JsonValue {
	if (!row || typeof row !== "object" || Array.isArray(row)) {
		return row;
	}

	const values = row as Record<string, JsonValue>;
	const stats = Object.fromEntries(
		STOCK_STATS_FIELDS.filter((field) => Object.hasOwn(values, field)).map(
			(field) => [field, values[field]],
		),
	);
	return stats as JsonValue;
}

function parseStocksArguments(argv: string[]): {
	pretty: boolean;
	tickers: string[];
	source?: TickerSource;
} {
	const pretty = argv.includes("--pretty");
	const tickers: string[] = [];
	let source: TickerSource | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token || token === "--pretty") {
			continue;
		}
		if (token === "--source") {
			const rawSource = argv[index + 1];
			if (!isTickerSource(rawSource)) {
				throw new Error(
					`Invalid source. Use ${TICKER_SOURCE_VALUES.join(", ")}.`,
				);
			}
			source = rawSource;
			index += 1;
			continue;
		}
		if (token.startsWith("--")) {
			throw new Error(`Unknown option for stocks: ${token}`);
		}
		tickers.push(...arrayArgument(token).map((value) => String(value)));
	}

	if (tickers.length === 0) {
		throw new Error("At least one ticker is required.");
	}

	return { pretty, tickers, source };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const [command, ...rest] = argv;
	if (!command) {
		throw new Error("A command is required. Use help to inspect the CLI.");
	}

	if (command === "help") {
		printCommandList();
		return;
	}

	const { mcp } = await import("./mcp/index.js");

	if (command === "stocks") {
		const { pretty, tickers, source } = parseStocksArguments(rest);
		const entries = await Promise.all(
			tickers.map(async (ticker) => {
				const payload = await mcp.callTool("get_stock_stats", {
					ticker,
					...(source ? { source } : {}),
				});
				const content = payload.structuredContent;
				const row =
					content &&
					typeof content === "object" &&
					!Array.isArray(content) &&
					"row" in content
						? (content as Record<string, JsonValue>).row
						: content;
				return [String(ticker).toUpperCase(), stockStatsPayload(row)] as const;
			}),
		);
		console.log(
			JSON.stringify(
				Object.fromEntries(entries) as JsonValue,
				null,
				pretty ? 2 : undefined,
			),
		);
		return;
	}

	const tools = await mcp.listTools();
	const toolName = resolveCliToolName(command);
	const tool = toolName
		? tools.find((candidate) => candidate.name === toolName)
		: undefined;
	if (!tool) {
		throw new Error(`Unknown command: ${command}`);
	}

	const { pretty, arguments: toolArguments } = parseToolArguments(tool, rest);
	const payload = await mcp.callTool(tool.name, toolArguments);
	console.log(
		JSON.stringify(
			payload.structuredContent ?? asJsonValue(payload.content),
			null,
			pretty ? 2 : undefined,
		),
	);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
