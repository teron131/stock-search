import { describe, expect, it } from "vitest";

import {
	CLI_COMMANDS,
	resolveCliToolName,
} from "../../src/stock-search/cli.js";
import {
	commandName,
	stockSearchTools,
} from "../../src/stock-search/mcp/tools.js";

const allowedToolNames = new Set(
	CLI_COMMANDS.map((command) => command.toolName),
);

describe("CLI command surface", () => {
	it("exposes only curated human-facing commands", () => {
		expect(CLI_COMMANDS.map((command) => command.command)).toEqual([
			"stocks",
			"sectors",
			"news",
			"evaluate",
		]);
	});

	it("maps stocks to flattened stock stats instead of raw stored stocks", () => {
		expect(resolveCliToolName("stocks")).toBe("get_stock_stats");
	});

	it("does not resolve backend or route-shaped commands", () => {
		const blockedCommands = [
			"commands",
			"list-tools",
			"stock",
			"eval",
			"get-portfolio",
			"get_portfolio",
			"stock-map",
			"eval-map",
			"get-stock-map",
			"get_stock_map",
			"get-eval-map",
			"get_eval_map",
			"upsert-portfolio-position",
			"remove-portfolio-position",
			"get-stock-stats",
			"get_stock_stats",
			"get-stock-news",
			"get-color-standards",
			"get-realtime-config",
			"colors",
			"realtime",
			"evaluate-stock",
			"sectors-api-sectors-get",
			"serve-dashboard-dashboard-get",
			"auth-session-auth-session-get",
			"portfolio-news-summary-api-portfolio-news-summary-post",
		];

		for (const command of blockedCommands) {
			expect(resolveCliToolName(command)).toBeUndefined();
		}
	});

	it("does not expose uncurated MCP tools under their generated CLI names", () => {
		for (const tool of stockSearchTools) {
			if (allowedToolNames.has(tool.name)) {
				continue;
			}

			expect(resolveCliToolName(commandName(tool.name))).toBeUndefined();
		}
	});
});
