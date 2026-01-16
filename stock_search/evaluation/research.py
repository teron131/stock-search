from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
import os
import re
from typing import Any, Literal

from langchain.agents import create_agent
from langchain.agents.middleware import TodoListMiddleware
from langchain.tools import ToolRuntime, tool
from langchain_core.messages import HumanMessage
from langgraph.graph import END, START, StateGraph
from langgraph.store.memory import InMemoryStore
from pydantic import BaseModel, Field

from ..llm_harness.agents import WebLoaderAgent
from ..llm_harness.openrouter import ChatOpenRouter
from ..utils import extract_domain
from .constants import ThresholdConfig

DEFAULT_ALLOWED_DOMAINS: tuple[str, ...] = (
    "example.com",
    "placeholder.org",
)

RESEARCH_AGENT_PROMPT = """Research with web search to find reliable, recent sources.
Focus on concrete facts, numbers, and named entities. No meta-language. Exclude ads/boilerplate.
Return concise bullet points with sources."""

WEBLOADER_AGENT_PROMPT = """Loads and summarizes pages from approved domains.
Extract only facts that help score moat, quality, and outlook. No meta-language.
Return short bullet points with sources if available."""

VALIDATOR_AGENT_PROMPT = """Validates claims for factual support.
Flag statements that lack evidence or conflict with sources. Return a short checklist of issues or "ok"."""

MAX_VALIDATION_RETRIES = 2
_STORE = InMemoryStore()


class ResearchGraphInput(BaseModel):
    ticker: str


class ResearchGraphOutput(BaseModel):
    structured_response: Any | None = None


class ValidationResult(BaseModel):
    is_valid: bool = Field(description="True if the notes are grounded and factually supported.")
    reasons: list[str] = Field(default_factory=list, description="List of issues or reasons for invalidity.")


class ResearchGraphState(BaseModel):
    ticker: str
    research_notes: str | None = None
    loaded_notes: str | None = None
    validation: ValidationResult | None = None
    attempts: int = 0
    plan: str | None = None
    structured_response: Any | None = None


def _get_allowed_domains() -> set[str]:
    """Get set of allowed domains from environment or defaults."""
    env = os.getenv("RESEARCH_ALLOWED_DOMAINS", "")
    if env:
        return {item.strip().lower() for item in env.split(",") if item.strip()}
    return set(ThresholdConfig.DEFAULT_ALLOWED_DOMAINS)


def _is_domain_allowed(domain: str, allowed: set[str]) -> bool:
    """Check if a domain or its parent is in the allowed list."""
    domain = domain.lower()
    return any(domain == entry or domain.endswith(f".{entry}") for entry in allowed)


def _filter_allowed_urls(urls: Iterable[str]) -> list[str]:
    """Filter URLs based on the allowed domains list."""
    allowed = _get_allowed_domains()
    return [url for url in urls if (d := extract_domain(url),) and _is_domain_allowed(d, allowed)]


def _extract_urls(text: str | None) -> list[str]:
    """Extract HTTP/HTTPS URLs from text."""
    if not text:
        return []
    return re.findall(r"https?://[^\s\]\)>,]+", text)


def _extract_todo_items(plan: str | None) -> list[str]:
    """Extract individual tasks from a markdown-style todo list."""
    if not plan:
        return []
    items = []
    for line in plan.splitlines():
        line = line.strip().lstrip("-").lstrip("*").strip()
        if not line:
            continue
        if line.lower().startswith(("todo:", "plan:")):
            line = line.split(":", 1)[-1].strip()
        items.append(line)
    return items


def _extract_ticker(text: str | None) -> str | None:
    """Extract a ticker symbol from text or a 'Ticker: SYMBOL' pattern."""
    if not text:
        return None
    candidate = text.strip()
    if re.fullmatch(r"[A-Za-z0-9\.-]{1,10}", candidate):
        return candidate.upper()
    match = re.search(r"Ticker:\s*([A-Za-z0-9\.-]+)", text)
    return match.group(1).upper() if match else None


def _chunk_list(values: list[str], size: int) -> list[list[str]]:
    """Split a list into chunks of a specified size."""
    if size <= 0:
        return [values]
    return [values[i : i + size] for i in range(0, len(values), size)]


@tool("load_research_memory", description="Load cached research notes for a ticker.")
def load_research_memory(
    ticker: str,
    runtime: ToolRuntime,
) -> str:
    stored = runtime.store.get(
        ("research",),
        ticker.upper(),
    )
    return str(stored.value) if stored and stored.value else ""


@tool("save_research_memory", description="Save research notes for a ticker.")
def save_research_memory(
    ticker: str,
    notes: str,
    runtime: ToolRuntime,
) -> str:
    runtime.store.put(
        ("research",),
        ticker.upper(),
        notes,
    )
    return "saved"


class ResearchAgents:
    """Container for research-specific agents."""

    def __init__(self, system_prompt: str, response_format: type[BaseModel]):
        quality_model = os.getenv("QUALITY_LLM")
        fast_model = os.getenv("FAST_LLM", quality_model)

        self.supervisor = create_agent(
            model=ChatOpenRouter(
                model=quality_model,
                temperature=0,
                reasoning_effort="medium",
            ),
            tools=[
                load_research_memory,
                save_research_memory,
            ],
            system_prompt=system_prompt,
            response_format=response_format,
            middleware=[TodoListMiddleware()],
            store=_STORE,
        )

        self.searcher = create_agent(
            model=ChatOpenRouter(
                model=quality_model,
                temperature=0,
                reasoning_effort="medium",
                web_search=True,
                web_search_max_results=ThresholdConfig.WEB_SEARCH_MAX_RESULTS,
            ),
            tools=[load_research_memory],
            system_prompt=RESEARCH_AGENT_PROMPT,
            store=_STORE,
        )

        self.loader = WebLoaderAgent(
            model=fast_model,
            temperature=0,
            reasoning_effort="low",
            system_prompt=WEBLOADER_AGENT_PROMPT,
        )

        self.validator = create_agent(
            model=ChatOpenRouter(
                model=fast_model,
                temperature=0,
                reasoning_effort="medium",
            ),
            tools=[],
            system_prompt=VALIDATOR_AGENT_PROMPT,
            response_format=ValidationResult,
            store=_STORE,
        )


def _build_research_graph(system_prompt: str, response_format: type[BaseModel]) -> Any:
    agents = ResearchAgents(system_prompt, response_format)

    def run_planner(state: ResearchGraphState) -> dict[str, Any]:
        prompt = f"Create a short todo list for researching this ticker. Do not answer the task.\nTicker: {state.ticker}"
        response = agents.supervisor.invoke(
            {
                "messages": [HumanMessage(content=prompt)],
            }
        )
        return {
            "plan": response["messages"][-1].content,
        }

    def run_fanout(state: ResearchGraphState) -> dict[str, Any]:
        return {
            "ticker": state.ticker,
            "research_notes": None,
            "loaded_notes": None,
            "validation": None,
        }

    def run_websearch(state: ResearchGraphState) -> dict[str, Any]:
        ticker = state.ticker or _extract_ticker(state.ticker)
        queries = _extract_todo_items(state.plan) or [state.ticker]

        def _search_one(query: str) -> str:
            prompt = f"{query}\nSummarize with concrete facts, numbers, and named entities. No meta-language.\nReturn concise bullet points. Include a 'Sources:' list with URLs you used."
            response = agents.searcher.invoke(
                {
                    "messages": [HumanMessage(content=prompt)],
                }
            )
            return response["messages"][-1].content

        with ThreadPoolExecutor(max_workers=min(len(queries), 5)) as executor:
            notes = "\n\n".join(executor.map(_search_one, queries))
        return {
            "ticker": ticker,
            "research_notes": notes,
        }

    def run_loader(state: ResearchGraphState) -> dict[str, Any]:
        urls = _filter_allowed_urls(_extract_urls(state.research_notes))
        if not urls:
            return {"loaded_notes": ""}

        url_batches = _chunk_list(urls, 5)

        def _load_batch(batch: list[str]) -> str:
            return agents.loader.invoke(f"Load and summarize these URLs:\n{batch}")

        with ThreadPoolExecutor(max_workers=min(len(url_batches), 5)) as executor:
            loaded = executor.map(_load_batch, url_batches)
            loaded = "\n\n".join(loaded)
        return {"loaded_notes": loaded}

    def run_validator(state: ResearchGraphState) -> dict[str, Any]:
        evidence = "\n\n".join(
            filter(
                None,
                [
                    state.research_notes,
                    state.loaded_notes,
                ],
            )
        )
        prompt = (
            f"Check the response for unsupported claims.\nIf everything is grounded, set is_valid=True. Otherwise set is_valid=False and list the reasons.\n\nNotes:\n{evidence}"
        )
        response = agents.validator.invoke({"messages": [HumanMessage(content=prompt)]})
        return {
            "validation": response.get("structured_response"),
            "attempts": state.attempts + 1,
        }

    def run_writer(state: ResearchGraphState) -> dict[str, Any]:
        evidence = "\n\n".join(filter(None, [state.research_notes, state.loaded_notes]))
        prompt = f"{state.ticker}\n\nEvidence:\n{evidence}"
        response = agents.supervisor.invoke(
            {
                "messages": [HumanMessage(content=prompt)],
            }
        )
        result = response.get("structured_response")
        if state.ticker and result:
            _STORE.put(("research",), state.ticker, str(result))
        return {"structured_response": result}

    def route_from_validator(state: ResearchGraphState) -> Literal["writer", "end"]:
        if state.validation and state.validation.is_valid:
            return "end"
        if state.attempts >= MAX_VALIDATION_RETRIES:
            return "end"
        return "writer"

    graph = StateGraph(
        ResearchGraphState,
        input_schema=ResearchGraphInput,
        output_schema=ResearchGraphOutput,
    )
    graph.add_node("plan", run_planner)
    graph.add_node("fanout", run_fanout)
    graph.add_node("websearch", run_websearch)
    graph.add_node("loader", run_loader)
    graph.add_node("validator", run_validator)
    graph.add_node("writer", run_writer)

    graph.add_edge(START, "plan")
    graph.add_edge("plan", "fanout")
    graph.add_edge("fanout", "websearch")
    graph.add_edge("fanout", "loader")
    graph.add_edge("websearch", "writer")
    graph.add_edge("loader", "writer")
    graph.add_edge("writer", "validator")
    graph.add_conditional_edges(
        "validator",
        route_from_validator,
        {"writer": "writer", "end": END},
    )

    return graph.compile()


def run_llm_evaluation(
    ticker: str,
    system_prompt: str,
    response_format: type[BaseModel],
) -> BaseModel:
    """Execute structured LLM search/analysis for a specific ticker."""
    graph = _build_research_graph(
        system_prompt,
        response_format,
    )
    response = graph.invoke(
        ResearchGraphInput(ticker=ticker),
    )
    return response.get("structured_response")


def save_research_graph_png(
    system_prompt: str,
    response_format: type[BaseModel],
    path: str,
) -> str | None:
    """Render the research graph to a PNG file."""
    graph = _build_research_graph(system_prompt, response_format)
    png_bytes = graph.get_graph().draw_mermaid_png()
    with open(path, "wb") as f:
        f.write(png_bytes)
    return path
