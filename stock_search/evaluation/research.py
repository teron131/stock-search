import os
from typing import Any

from pydantic import BaseModel

from ..llm_harness.agents import WebSearchAgent
from ..utils import parse_ticker
from .constants import ThresholdConfig


def _run_llm_evaluation(ticker: str, system_prompt: str, response_format: type[BaseModel]) -> Any:
    """Execute structured LLM search/analysis for a specific ticker."""
    model = os.getenv("QUALITY_LLM")
    if not model:
        return None

    agent = WebSearchAgent(
        model=model,
        temperature=0,
        reasoning_effort="high",
        response_format=response_format,
        system_prompt=system_prompt,
        web_search_max_results=ThresholdConfig.WEB_SEARCH_MAX_RESULTS,
    )
    return agent.invoke(f"Ticker: {ticker}. Name:{parse_ticker(ticker)}.")
