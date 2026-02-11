from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class FieldDefinition:
    name: str
    category: Literal["market", "fundamental", "technical", "evaluation"]
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class EvalFieldDefinition:
    key: str
    aliases: tuple[str, ...] = ()


INDICATOR_FIELD_DEFINITIONS: tuple[FieldDefinition, ...] = (
    FieldDefinition(name="price", category="market"),
    FieldDefinition(name="change_percent", category="market"),
    FieldDefinition(name="market_cap", category="fundamental"),
    FieldDefinition(name="pe", category="fundamental"),
    FieldDefinition(name="pe_forward", category="fundamental"),
    FieldDefinition(name="peg", category="fundamental"),
    FieldDefinition(name="beta", category="fundamental"),
    FieldDefinition(name="iv", category="technical"),
    FieldDefinition(name="one_month_change_percent", category="market"),
    FieldDefinition(name="three_month_change_percent", category="market"),
    FieldDefinition(name="six_month_change_percent", category="market"),
    FieldDefinition(name="one_year_change_percent", category="market"),
    FieldDefinition(name="median_upside", category="evaluation"),
    FieldDefinition(name="revenue_growth", category="fundamental"),
    FieldDefinition(name="gross_margin", category="fundamental"),
    FieldDefinition(name="debt_to_equity", category="fundamental"),
    FieldDefinition(name="free_cash_flow", category="fundamental"),
    FieldDefinition(name="rsi", category="technical"),
    FieldDefinition(name="change", category="market"),
    FieldDefinition(name="mtd_change_percent", category="market"),
    FieldDefinition(name="ytd_change_percent", category="market"),
)

INDICATOR_FIELDS: tuple[str, ...] = tuple(field.name for field in INDICATOR_FIELD_DEFINITIONS)

MARKET_FIELDS: frozenset[str] = frozenset(
    {
        "price",
        "current_price",
        "change",
        "change_percent",
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
        "one_month_change_percent",
        "three_month_change_percent",
        "six_month_change_percent",
        "one_year_change_percent",
        "mtd_change_percent",
        "ytd_change_percent",
        "median_upside",
    }
)

EVAL_FIELD_DEFINITIONS: tuple[EvalFieldDefinition, ...] = (
    EvalFieldDefinition(key="overall", aliases=("score",)),
    EvalFieldDefinition(key="quality"),
    EvalFieldDefinition(key="valuation"),
    EvalFieldDefinition(key="moat"),
    EvalFieldDefinition(key="upside"),
    EvalFieldDefinition(key="bull", aliases=("bull_probability",)),
    EvalFieldDefinition(key="bear", aliases=("bear_probability",)),
)
