from __future__ import annotations

import asyncio

from langgraph.graph import END, START, StateGraph
from llm_harness.clients import ChatOpenAI, ExaAgent
from pydantic import BaseModel, Field, model_validator

from stock_search.common_utils import normalize_ticker_symbol
from stock_search.config import ModelConfig
from stock_search.models import INDUSTRY_LABELS, INDUSTRY_LABELS_BY_SECTOR

INDUSTRY_LABEL_SET = set(INDUSTRY_LABELS)
MAX_LABELS = 5


class Pillar(BaseModel):
    pillar: str = Field(description="Business pillar name.")
    portion: float | None = Field(
        default=None,
        description="Estimated portion of company valuation / revenue represented by this pillar (0-100).",
        ge=0,
        le=100,
    )
    description: str = Field(description="Brief one-sentence description of what this pillar does.")


class Pillars(BaseModel):
    pillars: list[Pillar] = Field(
        default_factory=list,
        description="Top business pillars ranked by strategic importance.",
        min_length=1,
        max_length=5,
    )


class Outlook(BaseModel):
    outlook: str = Field(description="Outlook of the company's existing pillars and emerging businesses.")
    impact: str = Field(description="Expected impact on the company's sector / industry exposure.")


class TickerLabels(BaseModel):
    labels: list[str] = Field(
        default_factory=list,
        description="Multi-label tags from the provided sector/industry taxonomy.",
        min_length=1,
        max_length=5,
    )

    @model_validator(mode="after")
    def validate_labels(self) -> TickerLabels:
        invalid_labels = [label for label in self.labels if label not in INDUSTRY_LABEL_SET]
        if invalid_labels:
            raise ValueError(f"labels must come from INDUSTRY_LABELS. Invalid: {invalid_labels}")
        return self


class LabelGraphInput(BaseModel):
    ticker: str


class LabelGraphOutput(BaseModel):
    labels: TickerLabels | None = None


class LabelGraphState(BaseModel):
    ticker: str
    pillars: Pillars | None = None
    outlook: Outlook | None = None
    labels: TickerLabels | None = None


PILLARS_SYSTEM_PROMPT = """Perspective: Current business pillars.

Task:
- Identify the company's current core pillars that drive revenue/profit/value today.

Finance guidance (be economically grounded):
- Prefer segment reporting and how the company itself breaks out revenue/profit (10-K/20-F, earnings deck, IR materials).
- Separate distinct business models when relevant (subscription vs usage-based, hardware vs services, ads vs transaction fees).
- Anchor pillars to cash-flow drivers (where gross profit comes from), not headlines or TAM narratives.
- If you provide `portion`, base it on reported segment mix or best-effort inference and keep it directionally plausible.

Rules:
- Use high-signal sources: filings, earnings materials, investor relations, reputable financial reporting.
- Avoid low-signal aggregation summaries.
- Do not copy third-party label taxonomies.
- Keep output concise and factual.
"""

OUTLOOK_QUERY = "Ticker: {ticker}\nCompany pillars context: {pillars}\nProvide concise outlook and sector/industry exposure impact."


OUTLOOK_SYSTEM_PROMPT = """Perspective: Forward outlook and exposure shift.

Task:
- Based on current pillars + fresh evidence, summarize near/medium-term outlook.
- Explain whether sector/industry exposure is likely to shift or mostly deepen.

Finance guidance (what to cover):
- Demand drivers: cyclical vs secular, and key end-markets.
- Competitive dynamics: pricing power, substitutes, switching costs, market share trajectory.
- Margin structure: mix shift, operating leverage, input costs.
- Risk factors: regulatory, customer concentration, geopolitics/supply chain, credit cycle (if relevant).
- Keep it timeframe-aware: near-term (next ~4 quarters) vs medium-term (1-3 years).

Rules:
- Stay practical and concise; avoid deep speculation.
- Use management guidance, product roadmap, and segment direction signals.
"""


LABEL_SYSTEM_PROMPT_TEMPLATE = """Final step: assign industry labels from two perspectives.

Inputs you receive:
- Perspective 1: current business pillars.
- Perspective 2: forward outlook and exposure impact.

Task:
- Produce final labels using ONLY those two perspectives.
- Choose 1 to {max_labels} labels from INDUSTRY_LABELS, ranked by importance.

Finance guidance (how to choose labels):
- Label the company by *economic exposure* (where revenue/gross profit is earned) rather than buzzwords.
- If the company is a "picks-and-shovels" supplier, label by the primary customer end-market(s) implied by pillars.
- If the company is diversified, pick labels that correspond to distinct pillars that together explain most of the business.

Selection rubric (consistency rules):
- Anchor each chosen label to a concrete pillar or outlook statement (revenue/profit/value driver).
- Prefer the most specific label that fits the described business; avoid overly broad labels.
- Do not pick "adjacent" labels just because they are related; pick the best-fit exposure.
- If two labels overlap, keep the more specific one unless there are clearly separate pillars.
- Order labels by estimated contribution to valuation/revenue today, then by near-term direction from outlook.

Hard rules:
- Do not introduce unsupported labels or synonyms.
- Do not rely on website taxonomies or third-party label sets.
- Do not copy labels from what you may have seen on websites; decide labels yourself based on the facts in the pillars/outlook.
- Do not perform web search in this final step.
- Output only the `labels` field (no extra text).

Allowed label taxonomy (sector -> industries; must choose only from these industries):
{allowed_labels_by_sector}
"""

LABEL_QUERY = "Ticker: {ticker}\nCompany pillars: {pillars}\nOutlook: {outlook}\nAssign final labels."


def _normalize_labels(labels: list[str]) -> list[str]:
    ordered_unique_labels = list(dict.fromkeys(labels))
    return [label for label in ordered_unique_labels if label in INDUSTRY_LABEL_SET][:MAX_LABELS]


def _build_label_system_prompt() -> str:
    allowed_labels_by_sector = "\n".join(f"- {sector}: {', '.join(industry_labels)}" for sector, industry_labels in INDUSTRY_LABELS_BY_SECTOR)
    return LABEL_SYSTEM_PROMPT_TEMPLATE.format(
        max_labels=MAX_LABELS,
        allowed_labels_by_sector=allowed_labels_by_sector,
    )


def _build_label_graph():
    async def pillar_node(state: LabelGraphState) -> dict[str, Pillars]:
        pillars_agent = ExaAgent(
            system_prompt=PILLARS_SYSTEM_PROMPT,
            output_schema=Pillars,
        )
        pillars = await asyncio.to_thread(pillars_agent.invoke, state.ticker)
        return {"pillars": pillars}

    async def outlook_node(state: LabelGraphState) -> dict[str, Outlook]:
        outlook_agent = ExaAgent(
            system_prompt=OUTLOOK_SYSTEM_PROMPT,
            output_schema=Outlook,
        )
        outlook_query = OUTLOOK_QUERY.format(
            ticker=state.ticker,
            pillars=state.pillars.model_dump_json(),
        )
        outlook = await asyncio.to_thread(outlook_agent.invoke, outlook_query)
        return {"outlook": outlook}

    async def label_node(state: LabelGraphState) -> dict[str, TickerLabels]:
        label_model = ChatOpenAI(
            model=ModelConfig.quality_or_fast(),
            temperature=0.1,
            reasoning_effort="medium",
        )
        label_query = LABEL_QUERY.format(
            ticker=state.ticker,
            pillars=state.pillars.model_dump_json(),
            outlook=state.outlook.model_dump_json(),
        )
        structured_label_model = label_model.with_structured_output(TickerLabels)
        raw_result = await asyncio.to_thread(
            structured_label_model.invoke,
            f"{_build_label_system_prompt()}\n\n{label_query}",
        )

        normalized_labels = _normalize_labels(raw_result.labels)
        if not normalized_labels:
            raise ValueError(f"Could not normalize labels into INDUSTRY_LABELS: {raw_result.labels}")

        return {"labels": TickerLabels(labels=normalized_labels)}

    graph = StateGraph(
        LabelGraphState,
        input_schema=LabelGraphInput,
        output_schema=LabelGraphOutput,
    )

    graph.add_node("pillars", pillar_node)
    graph.add_node("outlook", outlook_node)
    graph.add_node("labels", label_node)

    graph.add_edge(START, "pillars")
    graph.add_edge("pillars", "outlook")
    graph.add_edge("outlook", "labels")
    graph.add_edge("labels", END)

    return graph.compile()


async def aget_label(ticker: str) -> TickerLabels:
    ticker_symbol = normalize_ticker_symbol(ticker)
    if not ticker_symbol:
        raise ValueError("ticker cannot be empty")

    graph = _build_label_graph()
    response = await graph.ainvoke(LabelGraphInput(ticker=ticker_symbol))
    labels = response.get("labels")
    if not labels:
        raise ValueError("Label graph did not produce labels")
    return labels


async def aget_labels(
    tickers: list[str],
    *,
    max_concurrency: int = 4,
) -> dict[str, TickerLabels]:
    normalized_tickers = [ticker_symbol for ticker in tickers if (ticker_symbol := normalize_ticker_symbol(ticker))]
    ordered_unique_tickers = list(dict.fromkeys(normalized_tickers))
    if not ordered_unique_tickers:
        return {}

    semaphore = asyncio.Semaphore(max(1, max_concurrency))

    async def _fetch_one(ticker_symbol: str) -> tuple[str, TickerLabels | None]:
        async with semaphore:
            try:
                labels = await aget_label(ticker_symbol)
            except Exception:
                return ticker_symbol, None
            return ticker_symbol, labels

    results = await asyncio.gather(*(_fetch_one(ticker_symbol) for ticker_symbol in ordered_unique_tickers))
    return {ticker_symbol: labels for ticker_symbol, labels in results if labels is not None}


def get_label(ticker: str) -> TickerLabels:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(aget_label(ticker))
    raise RuntimeError("get_label cannot be called from an active event loop; use aget_label instead")


def get_labels(
    tickers: list[str],
    *,
    max_concurrency: int = 4,
) -> dict[str, TickerLabels]:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(aget_labels(tickers, max_concurrency=max_concurrency))
    raise RuntimeError("get_labels cannot be called from an active event loop; use aget_labels instead")
