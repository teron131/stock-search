/** FastMCP server that mirrors the stock-search backend tools. */

import { FastMCP } from "fastmcp";

import { callTool, listTools, stockSearchTools, toolHasParameters } from "./tools.js";

export const SERVER_NAME = "Stock Search MCP";

export type StockSearchMcpServer = FastMCP & {
  listTools: typeof listTools;
  callTool: typeof callTool;
};

export function createMcpServer(): StockSearchMcpServer {
  const server = new FastMCP({
    name: SERVER_NAME,
    version: "0.0.0",
  }) as StockSearchMcpServer;
  for (const tool of stockSearchTools) {
    server.addTool({
      name: tool.name,
      description: tool.description,
      ...(toolHasParameters(tool.parameters) ? { parameters: tool.parameters } : {}),
      execute: async (args) => (await tool.execute(args as Record<string, unknown>)) as never,
    });
  }
  server.listTools = listTools;
  server.callTool = callTool;
  return server;
}

export const mcp = createMcpServer();

export async function main(): Promise<void> {
  await mcp.start({
    transportType: "stdio",
  });
}
