"""CLI for calling the Stock Search MCP tools in-process."""

from __future__ import annotations

import argparse
import json
from typing import Any, cast

import anyio
from fastmcp.server.providers.openapi.components import OpenAPITool
from mcp.types import TextContent

from stock_search.mcp import mcp

type JSONScalar = str | int | float | bool | None
type JSONValue = JSONScalar | list["JSONValue"] | dict[str, "JSONValue"]

CLI_NAMESPACE_KEYS = {"command", "_builtin", "_tool_name", "compact"}


def _parse_bool(value: str) -> bool:
    """Parse a boolean CLI value."""
    normalized = value.strip().lower()
    if normalized in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "f", "no", "n", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"Invalid boolean value: {value}")


def _normalize_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Flatten simple nullable schemas into a single CLI-facing schema."""
    if "anyOf" not in schema:
        return schema

    non_null_options = [option for option in schema["anyOf"] if option.get("type") != "null"]
    if len(non_null_options) != 1:
        return schema

    normalized = dict(non_null_options[0])
    for key in ("title", "description", "default", "enum"):
        if key in schema and key not in normalized:
            normalized[key] = schema[key]
    return normalized


def _json_argument(value: str) -> Any:
    """Parse a JSON CLI value for complex tool parameters."""
    try:
        return json.loads(value)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(f"Invalid JSON value: {value}") from exc


def _as_json_value(value: Any) -> JSONValue:
    """Normalize a value into a JSON-compatible type."""
    return cast(JSONValue, json.loads(json.dumps(value, ensure_ascii=False, default=str)))


def _argument_options(schema: dict[str, Any]) -> dict[str, Any]:
    """Build argparse kwargs from a JSON schema fragment."""
    normalized = _normalize_schema(schema)
    schema_type = normalized.get("type")

    options: dict[str, Any] = {}
    if schema_type == "integer":
        options["type"] = int
    elif schema_type == "number":
        options["type"] = float
    elif schema_type == "boolean":
        options["type"] = _parse_bool
    elif schema_type in {"array", "object"}:
        options["type"] = _json_argument
        options["metavar"] = "JSON"
    else:
        options["type"] = str

    if "enum" in normalized:
        options["choices"] = normalized["enum"]

    return options


def _help_text(schema: dict[str, Any]) -> str | None:
    """Build help text from one schema fragment."""
    help_parts: list[str] = []
    if title := schema.get("title"):
        help_parts.append(title)
    if "default" in schema:
        help_parts.append(f"default: {schema['default']}")
    return "; ".join(help_parts) or None


def _command_name(tool_name: str) -> str:
    """Convert an MCP tool name into a CLI subcommand name."""
    return tool_name.replace("_", "-")


async def _list_tools_async() -> list[OpenAPITool]:
    """Return the available MCP tools."""
    return await mcp.list_tools()


async def _call_tool_async(tool_name: str, arguments: dict[str, Any]) -> JSONValue:
    """Call one MCP tool and return a JSON-serializable payload."""
    result = await mcp.call_tool(tool_name, arguments)
    if result.structured_content is not None:
        return _as_json_value(result.structured_content)

    serialized_blocks: list[JSONValue] = []
    for block in result.content:
        if isinstance(block, TextContent):
            text = block.text
            try:
                serialized_blocks.append(_as_json_value(json.loads(text)))
            except json.JSONDecodeError:
                serialized_blocks.append(text)
            continue
        serialized_blocks.append(_as_json_value(block.model_dump(mode="json")))

    if len(serialized_blocks) == 1:
        return serialized_blocks[0]
    return serialized_blocks


def _add_tool_argument(
    parser: argparse.ArgumentParser,
    parameter_name: str,
    parameter_schema: dict[str, Any],
    *,
    required: bool,
) -> None:
    """Add one tool argument to a parser."""
    options = _argument_options(parameter_schema)
    help_text = _help_text(parameter_schema)
    if required:
        parser.add_argument(parameter_name, help=help_text, **options)
        return

    parser.add_argument(
        f"--{parameter_name.replace('_', '-')}",
        dest=parameter_name,
        default=argparse.SUPPRESS,
        help=help_text,
        **options,
    )


def _build_tool_parser(subparsers: Any, tool: OpenAPITool) -> None:
    """Create one CLI subcommand from an MCP tool definition."""
    command_name = _command_name(tool.name)
    tool_parser = subparsers.add_parser(command_name, help=tool.description or None, description=tool.description or None)
    tool_parser.set_defaults(_tool_name=tool.name)

    parameters = tool.parameters or {}
    properties = parameters.get("properties", {})
    required_names = set(parameters.get("required", []))

    for parameter_name, parameter_schema in properties.items():
        _add_tool_argument(
            tool_parser,
            parameter_name,
            parameter_schema,
            required=parameter_name in required_names,
        )


def _build_parser(tools: list[OpenAPITool]) -> argparse.ArgumentParser:
    """Build the CLI parser from the MCP tool schemas."""
    parser = argparse.ArgumentParser(description="CLI for the Stock Search MCP tools.")
    parser.add_argument("--compact", action="store_true", help="Print compact JSON instead of pretty-printed output.")

    subparsers = parser.add_subparsers(dest="command", required=True)
    list_parser = subparsers.add_parser("list-tools", help="List the available tool commands.")
    list_parser.set_defaults(_builtin="list-tools")

    for tool in tools:
        _build_tool_parser(subparsers, tool)

    return parser


def _print_tool_list(tools: list[OpenAPITool]) -> None:
    """Print the available CLI commands."""
    for tool in tools:
        description = tool.description or ""
        print(f"{_command_name(tool.name)}\t{description}".rstrip())


def _namespace_arguments(namespace: argparse.Namespace) -> dict[str, Any]:
    """Extract tool arguments from the parsed namespace."""
    return {key: value for key, value in vars(namespace).items() if key not in CLI_NAMESPACE_KEYS}


def _print_payload(payload: JSONValue, *, compact: bool) -> None:
    """Print the payload as JSON."""
    indent = None if compact else 2
    print(json.dumps(payload, indent=indent, ensure_ascii=False, default=str))


def main() -> None:
    """Run the Stock Search CLI."""
    tools = anyio.run(_list_tools_async)
    parser = _build_parser(tools)
    namespace = parser.parse_args()

    if getattr(namespace, "_builtin", None) == "list-tools":
        _print_tool_list(tools)
        return

    tool_name = namespace._tool_name
    arguments = _namespace_arguments(namespace)
    payload = anyio.run(_call_tool_async, tool_name, arguments)
    _print_payload(payload, compact=namespace.compact)
