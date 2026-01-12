import os
from pathlib import Path
from typing import Any, Literal

from langchain.agents import create_agent
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel

from .multimodal import MediaMessage
from .openrouter import ChatOpenRouter
from .tools import webloader_tool

ReasoningEffort = Literal["minimal", "low", "medium", "high"]


class WebSearchAgent:
    """Agent that uses web search capabilities to find and process information."""

    def __init__(
        self,
        model: str | None = None,
        temperature: float = 0,
        reasoning_effort: ReasoningEffort = "medium",
        system_prompt: str | None = None,
        response_format: type[BaseModel] | None = None,
        web_search_max_results: int = 5,
        **model_kwargs: Any,
    ):
        """Initialize web search agent.

        Args:
            model: Model identifier (defaults to FAST_LLM env var)
            temperature: Sampling temperature for generation
            reasoning_effort: Level of reasoning effort for the model
            system_prompt: Optional system prompt to guide behavior
            response_format: Optional Pydantic model for structured output
            web_search_max_results: Maximum number of search results to retrieve
            **model_kwargs: Additional arguments passed to ChatOpenRouter
        """
        model = model or os.getenv("FAST_LLM")
        self.system_prompt = system_prompt
        self.response_format = response_format
        self.model = ChatOpenRouter(
            model=model,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            web_search=True,
            web_search_max_results=web_search_max_results,
            **model_kwargs,
        )
        if self.response_format:
            self.model = self.model.with_structured_output(self.response_format)

    def invoke(self, user_input: str) -> BaseModel | str:
        """Execute web search and process results."""
        messages = []
        if self.system_prompt:
            messages.append(SystemMessage(content=self.system_prompt))
        messages.append(HumanMessage(content=user_input))
        response = self.model.invoke(messages)
        return response if self.response_format else response.content


class WebLoaderAgent:
    """Agent that loads web content from URLs and processes it using tools."""

    def __init__(
        self,
        model: str | None = None,
        temperature: float = 0,
        reasoning_effort: ReasoningEffort = "medium",
        system_prompt: str | None = None,
        response_format: type[BaseModel] | None = None,
        **model_kwargs: Any,
    ):
        """Initialize web loader agent with tool capabilities.

        Args:
            model: Model identifier (defaults to FAST_LLM env var)
            temperature: Sampling temperature for generation
            reasoning_effort: Level of reasoning effort for the model
            system_prompt: Optional system prompt to guide behavior
            response_format: Optional Pydantic model for structured output
            **model_kwargs: Additional arguments passed to ChatOpenRouter
        """
        model = model or os.getenv("FAST_LLM")
        self.system_prompt = system_prompt
        self.response_format = response_format
        self.model = ChatOpenRouter(
            model=model,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            **model_kwargs,
        )
        self.agent = create_agent(
            model=self.model,
            tools=[webloader_tool],
            system_prompt=self.system_prompt,
            response_format=self.response_format,
        )

    def invoke(self, user_input: str) -> BaseModel | str:
        """Load and process web content based on user input."""
        response = self.agent.invoke(
            {"messages": [HumanMessage(content=user_input)]},
        )
        if self.response_format:
            return response.get("structured_response")
        return response.get("messages")[-1].content


class ImageAnalysisAgent:
    """Agent that accepts image inputs and returns structured or plain responses."""

    def __init__(
        self,
        model: str | None = None,
        temperature: float = 0,
        reasoning_effort: ReasoningEffort = "medium",
        system_prompt: str | None = None,
        response_format: type[BaseModel] | None = None,
        **model_kwargs: Any,
    ):
        """Initialize image analysis agent.

        Args:
            model: Model identifier (defaults to FAST_LLM env var)
            temperature: Sampling temperature for generation
            reasoning_effort: Level of reasoning effort for the model
            system_prompt: Optional system prompt to guide behavior
            response_format: Optional Pydantic model for structured output
            **model_kwargs: Additional arguments passed to ChatOpenRouter
        """
        model = model or os.getenv("FAST_LLM")
        self.system_prompt = system_prompt
        self.model = ChatOpenRouter(
            model=model,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            **model_kwargs,
        )
        self.response_format = response_format
        if self.response_format:
            self.model = self.model.with_structured_output(self.response_format)

    def invoke(self, image_paths: str | Path | list[str | Path]) -> BaseModel | str:
        """Analyze one or more images with a prompt."""
        messages: list[HumanMessage | SystemMessage] = []
        if self.system_prompt:
            messages.append(SystemMessage(content=self.system_prompt))
        messages.append(MediaMessage(image_paths))

        response = self.model.invoke(messages)
        return response if self.response_format else response.content
