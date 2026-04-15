"""Define field metadata used by the dashboard and API."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class FieldDefinition:
    """Describe one dashboard field."""

    name: str
    category: Literal["market", "fundamental", "technical", "evaluation"]
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class EvalFieldDefinition:
    """Describe one evaluation-specific field."""

    key: str
    aliases: tuple[str, ...] = ()


INDICATOR_FIELD_DEFINITIONS: tuple[FieldDefinition, ...] = (
    FieldDefinition(name="price", category="market"),
    FieldDefinition(name="change_percent_1d", category="market"),
    FieldDefinition(name="change", category="market"),
    FieldDefinition(name="market_cap", category="fundamental"),
    FieldDefinition(name="pe", category="fundamental"),
    FieldDefinition(name="pe_forward", category="fundamental"),
    FieldDefinition(name="peg", category="fundamental"),
    FieldDefinition(name="beta", category="fundamental"),
    FieldDefinition(name="iv", category="technical"),
    FieldDefinition(name="change_percent_1m", category="market"),
    FieldDefinition(name="change_percent_3m", category="market"),
    FieldDefinition(name="change_percent_6m", category="market"),
    FieldDefinition(name="change_percent_1y", category="market"),
    FieldDefinition(name="change_percent_mtd", category="market"),
    FieldDefinition(name="change_percent_ytd", category="market"),
    FieldDefinition(name="median_upside", category="evaluation"),
    FieldDefinition(name="revenue_growth", category="fundamental"),
    FieldDefinition(name="gross_margin", category="fundamental"),
    FieldDefinition(name="debt_to_equity", category="fundamental"),
    FieldDefinition(name="free_cash_flow", category="fundamental"),
    FieldDefinition(name="rsi", category="technical"),
)

INDICATOR_FIELDS: tuple[str, ...] = tuple(field.name for field in INDICATOR_FIELD_DEFINITIONS)

MARKET_FIELDS: frozenset[str] = frozenset(
    {
        "price",
        "change",
        "change_percent_1d",
        "market_cap",
        "pe",
        "pe_forward",
        "peg",
        "beta",
        "iv",
        "debt_to_equity",
        "free_cash_flow",
        "revenue_growth",
        "gross_margin",
        "rsi",
        "change_percent_1m",
        "change_percent_3m",
        "change_percent_6m",
        "change_percent_1y",
        "change_percent_mtd",
        "change_percent_ytd",
        "median_upside",
    }
)

EVAL_FIELD_DEFINITIONS: tuple[EvalFieldDefinition, ...] = (
    EvalFieldDefinition(key="overall_score"),
    EvalFieldDefinition(key="quality_score"),
    EvalFieldDefinition(key="valuation_score"),
    EvalFieldDefinition(key="moat_score"),
    EvalFieldDefinition(key="upside_score"),
    EvalFieldDefinition(key="bull_probability"),
    EvalFieldDefinition(key="bear_probability"),
)
