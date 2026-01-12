import os

from langchain.agents import create_agent
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel

from .openrouter import ChatOpenRouter
from .tools import webloader_tool


class WebSearchAgent:
    """Agent that uses the web search tool to search the web and then uses the model to process the content."""

    def __init__(
        self,
        model: str | None = None,
        system_prompt: str | None = None,
        response_format: BaseModel | None = None,
    ):
        self.model = ChatOpenRouter(
            model=model if model else os.getenv("FAST_LLM"),
            temperature=0,
            reasoning_effort="medium",
            web_search=True,
            web_search_max_results=5,
        )
        self.system_prompt = system_prompt
        self.response_format = response_format

    def invoke(self, user_input: str) -> BaseModel | str:
        response = self.model.invoke(
            [
                SystemMessage(content=self.system_prompt),
                HumanMessage(content=user_input),
            ],
        )
        return response if self.response_format else response.content


class WebLoaderAgent:
    """Agent that uses the webloader tool to load web content and then uses the model to process the content."""

    def __init__(
        self,
        model: str | None = None,
        system_prompt: str | None = None,
        response_format: BaseModel | None = None,
    ):
        self.model = ChatOpenRouter(
            model=model if model else os.getenv("FAST_LLM"),
            temperature=0,
            reasoning_effort="medium",
        )
        self.system_prompt = system_prompt
        self.response_format = response_format
        self.agent = create_agent(
            model=self.model,
            tools=[webloader_tool],
            system_prompt=self.system_prompt,
            response_format=self.response_format,
        )

    def invoke(self, user_input: str) -> BaseModel | str:
        response = self.agent.invoke({"messages": [HumanMessage(content=user_input)]})
        return response.get("structured_response") if self.response_format else response.content
