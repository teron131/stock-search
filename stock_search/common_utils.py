"""Common utility functions used across the stock-search codebase.

This module consolidates frequently duplicated helper functions to reduce
code repetition and maintain consistent behavior.
"""

from __future__ import annotations

from contextlib import suppress
import math
from typing import Any


def safe_float(value: Any) -> float | None:
    """Safely parse finite float values from any input.

    Returns None for non-numeric inputs, NaN, or infinity values.
    """
    with suppress(TypeError, ValueError):
        converted = float(value)
        return converted if math.isfinite(converted) else None
    return None


def round_optional(value: float | None, decimals: int = 2) -> float | None:
    """Round a float value to specified decimals, preserving None.

    Args:
        value: Float value or None
        decimals: Number of decimal places (default: 2)

    Returns:
        Rounded value or None if input was None
    """
    return round(float(value), decimals) if value is not None else None


def clamp(value: float, min_val: float, max_val: float) -> float:
    """Clamp a value to a specified range.

    Args:
        value: Value to clamp
        min_val: Minimum allowed value
        max_val: Maximum allowed value

    Returns:
        Clamped value within [min_val, max_val]
    """
    return max(min_val, min(max_val, value))


def to_float(value: Any, default: float) -> float:
    """Convert value to float with a fallback default.

    Args:
        value: Value to convert
        default: Default value if conversion fails

    Returns:
        Converted float or default value
    """
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


# Market cap formatting constants and function
MARKET_CAP_UNITS: tuple[tuple[float, str], ...] = (
    (1_000_000_000_000, "T"),
    (1_000_000_000, "B"),
    (1_000_000, "M"),
    (1_000, "K"),
)


def format_market_cap(value: float | None) -> str | None:
    """Format market cap with T/B/M/K suffix.

    Args:
        value: Market cap value in dollars

    Returns:
        Formatted string like "1.234T" or None if input is None
    """
    if value is None:
        return None

    try:
        numeric_value = float(value)
    except (TypeError, ValueError):
        return None

    for divisor, suffix in MARKET_CAP_UNITS:
        if numeric_value >= divisor:
            return f"{numeric_value / divisor:.3f}{suffix}"

    return f"{numeric_value:.3f}"
