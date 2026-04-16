"""FastMCP server that proxies the existing FastAPI backend."""

from __future__ import annotations

from fastmcp import FastMCP
from fastmcp.server.providers.openapi import MCPType, RouteMap

from stock_search.api.app import app as fastapi_app

SERVER_NAME = "Stock Search MCP"

ROUTE_MAPS = [
    RouteMap(pattern=r"^/$", mcp_type=MCPType.EXCLUDE),
    RouteMap(pattern=r"^/portfolio/import-image$", mcp_type=MCPType.EXCLUDE),
    RouteMap(mcp_type=MCPType.TOOL),
]

MCP_NAMES = {
    "portfolio_api_portfolio_get": "get_portfolio",
    "patch_position_portfolio__ticker__patch": "upsert_portfolio_position",
    "remove_position_portfolio__ticker__delete": "remove_portfolio_position",
    "stock_ticker_stats_api_stock__ticker__stats_get": "get_stock_stats",
    "eval_api_eval_get": "get_eval_map",
    "stocks_api_stocks_get": "get_stock_map",
    "color_standards_api_color_standards_get": "get_color_standards",
    "realtime_config_api_realtime_config_get": "get_realtime_config",
    "news_api_stock__ticker__news_get": "get_stock_news",
    "evaluate_ticker_api_stock__ticker__evaluate_get": "evaluate_stock",
}


def create_mcp_server() -> FastMCP:
    """Create the FastMCP server from the existing FastAPI application."""
    return FastMCP.from_fastapi(
        fastapi_app,
        name=SERVER_NAME,
        route_maps=ROUTE_MAPS,
        mcp_names=MCP_NAMES,
    )


mcp = create_mcp_server()


def main() -> None:
    """Run the MCP server over stdio."""
    mcp.run()
