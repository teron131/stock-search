import os
from typing import Literal

from langchain.agents import create_agent
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel

from .openrouter import ChatOpenRouter
from .tools import webloader_tool


class BaseAgent:
    """Base agent class with common initialization and configuration."""

    def __init__(
        self,
        model: str | None = None,
        reasoning_effort: Literal["minimal", "low", "medium", "high"] = "medium",
        system_prompt: str | None = None,
        response_format: BaseModel | None = None,
        **model_kwargs,
    ):
        self.model = ChatOpenRouter(
            model=model or os.getenv("FAST_LLM"),
            temperature=0,
            reasoning_effort=reasoning_effort,
            **model_kwargs,
        )
        self.system_prompt = system_prompt
        self.response_format = response_format


class WebSearchAgent(BaseAgent):
    """Agent that uses the web search tool to search the web and then uses the model to process the content."""

    def __init__(
        self,
        model: str | None = None,
        system_prompt: str | None = None,
        response_format: BaseModel | None = None,
    ):
        super().__init__(
            model=model,
            system_prompt=system_prompt,
            response_format=response_format,
            web_search=True,
            web_search_max_results=5,
        )

    def invoke(self, user_input: str) -> BaseModel | str:
        messages = []
        if self.system_prompt:
            messages.append(SystemMessage(content=self.system_prompt))
        messages.append(HumanMessage(content=user_input))

        response = self.model.invoke(messages)
        return response if self.response_format else response.content


class WebLoaderAgent(BaseAgent):
    """Agent that uses the webloader tool to load web content and then uses the model to process the content."""

    def __init__(
        self,
        model: str | None = None,
        system_prompt: str | None = None,
        response_format: BaseModel | None = None,
    ):
        super().__init__(
            model=model,
            system_prompt=system_prompt,
            response_format=response_format,
        )
        self.agent = create_agent(
            model=self.model,
            tools=[webloader_tool],
            system_prompt=self.system_prompt,
            response_format=self.response_format,
        )

    def invoke(self, user_input: str) -> BaseModel | str:
        response = self.agent.invoke(
            {
                "messages": [HumanMessage(content=user_input)],
            }
        )
        if self.response_format:
            return response.get("structured_response")
        return response.get("messages")[-1].content  # Last message content
