/** CLI for calling the Stock Search MCP tools in-process. */

import { mcp } from "./mcp/index.js";
import { commandName, type JsonValue, type OpenApiTool } from "./mcp/tools.js";

const CLI_NAMESPACE_KEYS = new Set(["command", "_builtin", "_tool_name", "compact"]);

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

function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
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
	if (schemaType === "array" || schemaType === "object") {
		return jsonArgument(value);
	}
	return value;
}

function getToolByCommand(command: string, tools: OpenApiTool[]): OpenApiTool | undefined {
	return tools.find((tool) => commandName(tool.name) === command);
}

function printToolList(tools: OpenApiTool[]): void {
	for (const tool of tools) {
		const description = tool.description ?? "";
		console.log(`${commandName(tool.name)}\t${description}`.trimEnd());
	}
}

function parseToolArguments(
	tool: OpenApiTool,
	argv: string[],
): { compact: boolean; arguments: Record<string, unknown> } {
	const compact = argv.includes("--compact");
	const parameters =
		tool.parameters && typeof tool.parameters === "object" ? tool.parameters : {};
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
		if (!token || CLI_NAMESPACE_KEYS.has(token.replace(/^--/, ""))) {
			continue;
		}
		if (token.startsWith("--")) {
			const parameterName = token.slice(2).replaceAll("-", "_");
			const parameterSchema = properties[parameterName];
			if (!parameterSchema) {
				throw new Error(`Unknown option for ${commandName(tool.name)}: ${token}`);
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
		values[parameterName] = parseArgumentValue(properties[parameterName], rawValue);
	});

	return {
		compact,
		arguments: values,
	};
}

function printPayload(payload: JsonValue, compact: boolean): void {
	console.log(JSON.stringify(payload, null, compact ? undefined : 2));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const tools = await mcp.listTools();
	const [command, ...rest] = argv;
	if (!command) {
		throw new Error("A command is required. Use list-tools to inspect the CLI.");
	}

	if (command === "list-tools") {
		printToolList(tools);
		return;
	}

	const tool = getToolByCommand(command, tools);
	if (!tool) {
		throw new Error(`Unknown command: ${command}`);
	}

	const { compact, arguments: toolArguments } = parseToolArguments(tool, rest);
	const payload = await mcp.callTool(tool.name, toolArguments);
	printPayload(
		payload.structuredContent ?? asJsonValue(payload.content),
		compact,
	);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
