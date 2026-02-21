from __future__ import annotations

import os

from llm_harness.clients import ExaAgent
from llm_harness.clients.openrouter import ChatOpenRouter
from pydantic import BaseModel, Field, model_validator
from rich import print as rprint

from stock_search.schemas import INDUSTRY_LABELS

INDUSTRY_LABEL_SET = set(INDUSTRY_LABELS)

OUTLOOK_QUERY = "Ticker: {ticker}\nCompany pillars context: {pillars}\nProvide concise outlook and sector/industry exposure impact."
LABEL_QUERY = "Ticker: {ticker}\nCompany pillars: {pillars}\nOutlook: {outlook}\nAssign final labels and rationale."


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


class TickerLabelsResult(BaseModel):
    labels: list[str] = Field(
        default_factory=list,
        description="Multi-label tags from the provided sector/industry taxonomy.",
        min_length=1,
        max_length=3,
    )

    @model_validator(mode="after")
    def validate_labels(self) -> TickerLabelsResult:
        invalid_labels = [label for label in self.labels if label not in INDUSTRY_LABEL_SET]
        if invalid_labels:
            raise ValueError(f"labels must come from INDUSTRY_LABELS. Invalid: {invalid_labels}")
        return self


class TickerLabelsRaw(BaseModel):
    labels: list[str] = Field(
        default_factory=list,
        description="Raw multi-label tags before normalization.",
        min_length=1,
        max_length=3,
    )
    rationale: str = Field(description="One concise sentence explaining the selected labels.")


PILLARS_SYSTEM_PROMPT = """Perspective 1: Current business pillars.

Task:
- Identify the company's current core pillars that drive revenue/profit/value today.

Rules:
- Use high-signal sources: filings, earnings materials, investor relations, reputable financial reporting.
- Avoid low-signal aggregation summaries.
- Do not copy third-party label taxonomies.
- Keep output concise and factual.
"""


OUTLOOK_SYSTEM_PROMPT = """Perspective 2: Forward outlook and exposure shift.

Task:
- Based on current pillars + fresh evidence, summarize near/medium-term outlook.
- Explain whether sector/industry exposure is likely to shift or mostly deepen.

Rules:
- Stay practical and concise; avoid deep speculation.
- Use management guidance, product roadmap, and segment direction signals.
"""


LABEL_SYSTEM_PROMPT = f"""Final step: assign industry labels from two perspectives.

Inputs you receive:
- Perspective 1: current business pillars.
- Perspective 2: forward outlook and exposure impact.

Task:
- Produce final labels using ONLY those two perspectives.
- Choose 1 to 3 labels from INDUSTRY_LABELS, ranked by importance.

Rules:
- Do not introduce unsupported labels or synonyms.
- Do not rely on website taxonomies; use your own reasoning.
- Do not perform web search in this final step.
- Keep rationale short and directly tied to Perspective 1 + Perspective 2.

Allowed label pool (must choose only from these):
{", ".join(INDUSTRY_LABELS)}
"""


def _resolve_model_name() -> str:
    model_name = os.getenv("QUALITY_LLM") or os.getenv("FAST_LLM")
    if not model_name:
        raise ValueError("No model configured. Set QUALITY_LLM or FAST_LLM.")
    return model_name


def _normalize_labels(labels: list[str]) -> list[str]:
    ordered_unique_labels = list(dict.fromkeys(labels))
    return [label for label in ordered_unique_labels if label in INDUSTRY_LABEL_SET][:3]


def run_label(ticker: str) -> TickerLabelsResult:
    ticker_symbol = ticker.strip().upper()
    if not ticker_symbol:
        raise ValueError("ticker cannot be empty")

    pillars_agent = ExaAgent(
        system_prompt=PILLARS_SYSTEM_PROMPT,
        output_schema=Pillars,
    )
    pillars = pillars_agent.invoke(ticker_symbol)

    outlook_agent = ExaAgent(
        system_prompt=OUTLOOK_SYSTEM_PROMPT,
        output_schema=Outlook,
    )
    outlook_query = OUTLOOK_QUERY.format(
        ticker=ticker_symbol,
        pillars=pillars.model_dump_json(),
    )
    outlook = outlook_agent.invoke(outlook_query)

    label_model = ChatOpenRouter(
        model=_resolve_model_name(),
        temperature=0.1,
        reasoning_effort="medium",
    )
    label_query = LABEL_QUERY.format(
        ticker=ticker_symbol,
        pillars=pillars.model_dump_json(),
        outlook=outlook.model_dump_json(),
    )
    structured_label_model = label_model.with_structured_output(TickerLabelsRaw)
    result = structured_label_model.invoke(f"{LABEL_SYSTEM_PROMPT}\n\n{label_query}")

    normalized_labels = _normalize_labels(result.labels)

    if not normalized_labels:
        raise ValueError(f"Could not normalize labels into INDUSTRY_LABELS: {result.labels}")

    return TickerLabelsResult(labels=normalized_labels)


if __name__ == "__main__":
    rprint(run_label("NVDA"))
