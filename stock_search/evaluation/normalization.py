from __future__ import annotations

from typing import Any

from ..common_utils import to_float
from ..schemas import Evaluation, ScoredReason
from .constants import (
    DEFAULT_BEAR_PROBABILITY,
    DEFAULT_BULL_PROBABILITY,
    DEFAULT_SCORE,
    SCORE_SCALE,
)
from .scores import calculate_strategy_indices

_BUCKET_LABELS: dict[str, str] = {
    "core": "Strategic Core",
    "satellite": "Growth Satellites",
    "speculative": "Tactical Opportunities",
    "diversifier": "Risk Mitigation",
}
_DEFAULT_BUCKET = "Tactical Opportunities"


def normalize_eval_json(data: dict[str, Any]) -> dict[str, Any]:
    """Normalize an eval.json entry to canonical keys used by the app."""
    if not data:
        return {}

    return {
        "overall": to_float(data.get("overall", data.get("score")), DEFAULT_SCORE),
        "quality": to_float(data.get("quality"), DEFAULT_SCORE),
        "moat": to_float(data.get("moat"), DEFAULT_SCORE),
        "valuation": to_float(data.get("valuation"), DEFAULT_SCORE),
        "upside": to_float(data.get("upside"), DEFAULT_SCORE),
        "market_cap_score": to_float(data.get("market_cap_score", data.get("market_cap")), DEFAULT_SCORE),
        "bull": to_float(data.get("bull", data.get("bull_probability")), DEFAULT_BULL_PROBABILITY),
        "bear": to_float(data.get("bear", data.get("bear_probability")), DEFAULT_BEAR_PROBABILITY),
    }


def eval_from_json(data: dict[str, Any]) -> Evaluation | None:
    """Build an `Evaluation` model from an `eval.json` entry."""
    normalized = normalize_eval_json(data)
    if not normalized:
        return None

    return Evaluation(
        score=normalized["overall"],
        reasons=[],
        market_cap=normalized["market_cap_score"],
        valuation=normalized["valuation"],
        upside=normalized["upside"],
        bull_probability=normalized["bull"],
        bear_probability=normalized["bear"],
        moat=ScoredReason(score=normalized["moat"], reasons=[]),
        quality=ScoredReason(score=normalized["quality"], reasons=[]),
    )


def _strategy_label(indices: dict[str, float | None]) -> str:
    available = {name: value for name, value in indices.items() if value is not None}
    if not available:
        return _DEFAULT_BUCKET
    best_key = max(available.items(), key=lambda item: item[1])[0]
    return _BUCKET_LABELS.get(best_key, _DEFAULT_BUCKET)


def bucket_from_eval_json(ticker: str, data: dict[str, Any]) -> str | None:
    """Derive dashboard strategy label from a normalized `eval.json` entry."""
    del ticker

    normalized = normalize_eval_json(data)
    if not normalized:
        return None

    scores = {
        "moat": normalized["moat"],
        "quality": normalized["quality"],
        "valuation": normalized["valuation"],
        "upside": normalized["upside"],
        "size": normalized["market_cap_score"],
    }

    bull = normalized.get("bull")
    bear = normalized.get("bear")
    edge = None
    if bull is not None and bear is not None:
        edge = (bull * SCORE_SCALE) - (bear * SCORE_SCALE)

    indices = calculate_strategy_indices(scores, edge)
    return _strategy_label(indices)
