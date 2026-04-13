"""Generic Exa-backed fallback helpers for StockAnalysis pages."""

from __future__ import annotations

from collections.abc import Callable
import logging

from llm_harness.clients import ExaAgent

logger = logging.getLogger(__name__)


def invoke_stockanalysis_search[MODEL_TYPE](
    *,
    output_schema: type[MODEL_TYPE],
    system_prompt_template: str,
    query: str,
    prompt_values: dict[str, str],
) -> MODEL_TYPE:
    """Run a structured Exa search using a StockAnalysis-oriented prompt."""
    agent = ExaAgent(
        system_prompt=system_prompt_template.format(**prompt_values),
        output_schema=output_schema,
    )
    return agent.invoke(query)


def invoke_stockanalysis_search_or_default[MODEL_TYPE](
    *,
    output_schema: type[MODEL_TYPE],
    system_prompt_template: str,
    query: str,
    prompt_values: dict[str, str],
    default_factory: Callable[[], MODEL_TYPE],
    error_message: str,
) -> MODEL_TYPE:
    """Run a structured Exa search and return an empty model on failure."""
    try:
        result = invoke_stockanalysis_search(
            output_schema=output_schema,
            system_prompt_template=system_prompt_template,
            query=query,
            prompt_values=prompt_values,
        )
        if isinstance(result, output_schema):
            return result
    except Exception:
        logger.exception(error_message, prompt_values.get("ticker", "unknown"))
    return default_factory()
