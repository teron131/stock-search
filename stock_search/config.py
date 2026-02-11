"""Runtime configuration constants for the stock-search application.

This module consolidates configuration values that were previously scattered
across multiple files. Evaluation-specific constants remain in evaluation/constants.py.
"""

from typing import Final


class CacheConfig:
    """Configuration for live data caching in portfolio dashboard."""

    HISTORY_TTL_SECONDS: Final[int] = 60
    """Time-to-live for price/change history data (1 minute)."""

    HISTORY_STALE_SECONDS: Final[int] = 600
    """Stale threshold for history data (10 minutes)."""

    HISTORY_FAILURE_COOLDOWN_SECONDS: Final[int] = 180
    """Cooldown period after fetch failure (3 minutes)."""

    INFO_TTL_SECONDS: Final[int] = 3_600
    """Time-to-live for fundamental info data (1 hour)."""

    INFO_STALE_SECONDS: Final[int] = 172_800
    """Stale threshold for fundamental data (48 hours)."""

    INFO_FAILURE_COOLDOWN_SECONDS: Final[int] = 1_800
    """Cooldown period after fundamental fetch failure (30 minutes)."""

    LIVE_STATS_MIN_REQUEST_GAP_SECONDS: Final[float] = 0.0
    """Minimum gap between live stats requests (0 = no rate limiting)."""


class PortfolioConfig:
    """Configuration for portfolio generation and allocation."""

    TARGET_TOTAL_EQUITY: Final[float] = 1_000_000.0
    """Target total equity for sample portfolio generation."""

    MAX_POSITION_QTY: Final[int] = 500
    """Maximum quantity for a single position."""

    MAX_WORKERS: Final[int] = 8
    """Maximum thread pool workers for parallel operations."""


class UpdateTierLabels:
    """Labels for different data update frequency tiers."""

    FAST_LABEL: Final[str] = "history_1m"
    """Label for fast-updating data (price, change)."""

    SLOW_LABEL: Final[str] = "info_1h"
    """Label for slower-updating fundamental data."""

    RATINGS_LABEL: Final[str] = "ratings_1d"
    """Label for daily-updating analyst ratings."""

    EVAL_LABEL: Final[str] = "llm_optional"
    """Label for optional LLM evaluations."""

    ETF_HOLDINGS_LABEL: Final[str] = "llm_optional"
    """Label for optional ETF holdings data."""
