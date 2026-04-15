"""Define shared stat-family groupings and timestamp fields."""

from __future__ import annotations

from typing import Literal

StatsFamily = Literal[
    "market_data",
    "market_snapshot",
    "statistics",
    "financials",
    "ratings",
]

STAT_FAMILIES: tuple[StatsFamily, ...] = (
    "market_data",
    "market_snapshot",
    "statistics",
    "financials",
    "ratings",
)

FAMILY_FIELDS: dict[StatsFamily, tuple[str, ...]] = {
    "market_data": (
        "price",
        "change",
        "change_percent_1d",
    ),
    "market_snapshot": (
        "name",
        "quote_type",
        "iv",
        "rsi",
        "change_percent_1m",
        "change_percent_3m",
        "change_percent_6m",
        "change_percent_1y",
        "change_percent_mtd",
        "change_percent_ytd",
    ),
    "statistics": (
        "market_cap",
        "pe",
        "pe_forward",
        "peg",
        "beta",
        "free_cash_flow",
    ),
    "financials": (
        "revenue_growth",
        "gross_margin",
        "debt_to_equity",
    ),
    "ratings": (
        "median_upside",
        "ratings",
    ),
}

FIELD_TO_FAMILY: dict[str, StatsFamily] = {field: family for family, fields in FAMILY_FIELDS.items() for field in fields}

FAMILY_TIMESTAMP_FIELD: dict[StatsFamily, str] = {
    "market_data": "market_data_fetched_at",
    "market_snapshot": "market_snapshot_fetched_at",
    "statistics": "statistics_fetched_at",
    "financials": "financials_fetched_at",
    "ratings": "ratings_fetched_at",
}

BLOCKING_AUTO_FAMILIES: frozenset[StatsFamily] = frozenset({"market_data"})
NON_BLOCKING_AUTO_FAMILIES: frozenset[StatsFamily] = frozenset(family for family in STAT_FAMILIES if family not in BLOCKING_AUTO_FAMILIES)


def family_timestamp_fields(family: StatsFamily) -> tuple[str, ...]:
    """Return timestamp fields accepted for one stat family."""
    return (FAMILY_TIMESTAMP_FIELD[family],)
