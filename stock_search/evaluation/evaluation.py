from dataclasses import dataclass
import math
from typing import Any

from ..indicators import StockIndicator
from ..prompts import FUTURE_OUTLOOK_DEFINITION, RESEARCH_DEFINITION
from ..schemas import Evaluation, FutureOutlook, ResearchEvaluation, ScoredReason
from ..utils import parse_ticker
from .research import run_llm_evaluation
from .scores import (
    calculate_combined_upside_score,
    calculate_elo_delta,
    calculate_quality_signal_score,
    calculate_strategy_indices,
    calculate_valuation_score,
    check_fomo_conditions,
    get_game_tier,
    market_cap_score,
    model_probabilities,
)


@dataclass(frozen=True)
class EvaluationResult:
    inputs: Evaluation
    ticker: str | None
    p_up: float | None
    p_down: float | None
    p_flat: float | None
    edge: float | None
    confidence: float | None
    overall: float | None
    elo_delta: float | None
    elo_delta_dir: float | None
    elo_delta_exp: float | None
    core_index: float | None
    satellite_index: float | None
    speculative_index: float | None
    diversifier_index: float | None
    fomo_flag: bool
    game_tier: str


# --- Primary Entry Points ---


def _probabilities_from_scores(
    bull_score: float | None,
    bear_score: float | None,
) -> tuple[float | None, float | None, float | None]:
    p_up = round(bull_score / 10.0, 4) if bull_score is not None else None
    p_down = round(bear_score / 10.0, 4) if bear_score is not None else None

    p_flat = None
    if p_up is not None and p_down is not None:
        p_flat = max(0.0, round(1.0 - p_up - p_down, 4))
    return p_up, p_down, p_flat


def _blended_quality(
    research: ResearchEvaluation | None,
    quality_signal_score: float | None,
) -> ScoredReason | None:
    research_quality_score = research.quality.score if research and research.quality else None
    if research_quality_score is None and quality_signal_score is None:
        return None

    if research_quality_score is not None and quality_signal_score is not None:
        score = round((0.7 * research_quality_score) + (0.3 * quality_signal_score), 2)
    elif research_quality_score is not None:
        score = round(research_quality_score, 2)
    else:
        score = round(quality_signal_score or 0.0, 2)

    reasons = research.quality.reasons if research and research.quality else []
    return ScoredReason(score=score, reasons=reasons)


def build_inputs(ticker: str) -> Evaluation:
    """Fetch metrics and run LLM evaluations to build the Evaluation input model."""
    normalized = parse_ticker(ticker)
    indicator = StockIndicator(normalized)

    # 1. Qualitative Evaluation (LLM)
    outlook: FutureOutlook = run_llm_evaluation(
        ticker,
        FUTURE_OUTLOOK_DEFINITION,
        FutureOutlook,
    )
    research: ResearchEvaluation = run_llm_evaluation(
        ticker,
        RESEARCH_DEFINITION,
        ResearchEvaluation,
    )

    # 2. Market Metrics
    size_score = market_cap_score(normalized, indicator.info)
    valuation_score = calculate_valuation_score(indicator)
    quality_signal_score = calculate_quality_signal_score(indicator)
    upside_score = calculate_combined_upside_score(
        indicator.median_upside,
        indicator.ratings,
        outlook.score if outlook else None,
    )

    # 3. Probability Modeling
    bull_score, bear_score = model_probabilities(indicator, outlook)
    p_up, p_down, p_flat = _probabilities_from_scores(bull_score, bear_score)

    # 4. Input Assembly
    eval_data = {
        "valuation": valuation_score,
        "upside": upside_score,
        "market_cap": float(size_score) if size_score is not None else None,
        "bull_probability": p_up,
        "bear_probability": p_down,
        "flat_probability": p_flat,
    }

    if outlook:
        eval_data.update(
            outlook.model_dump(
                exclude={"bull_probability", "bear_probability"},
            )
        )
    if research:
        eval_data.update(research.model_dump())

    quality = _blended_quality(research, quality_signal_score)
    if quality is not None:
        eval_data["quality"] = quality

    return Evaluation(**eval_data)


def evaluate_asset(inputs: Evaluation, ticker: str | None = None) -> EvaluationResult:
    """Process an Evaluation model into a final EvaluationResult with indices and deltas."""
    p_up = inputs.bull_probability
    p_down = inputs.bear_probability
    p_flat = inputs.flat_probability
    if p_flat is None and p_up is not None and p_down is not None:
        p_flat = max(0.0, 1 - p_up - p_down)

    bull_score = p_up * 10.0 if p_up is not None else None
    bear_score = p_down * 10.0 if p_down is not None else None
    edge = bull_score - bear_score if bull_score is not None and bear_score is not None else None

    scores = {
        "moat": inputs.moat.score if inputs.moat else None,
        "quality": inputs.quality.score if inputs.quality else None,
        "valuation": inputs.valuation,
        "upside": inputs.upside,
        "size": inputs.market_cap,
    }

    # Core 4-metric average
    req = (scores["moat"], scores["quality"], scores["valuation"], scores["upside"])
    overall = sum(req) / 4 if all(v is not None for v in req) else None

    indices = calculate_strategy_indices(scores, edge)
    fomo_flag = check_fomo_conditions(scores, bull_score)

    return EvaluationResult(
        inputs=inputs,
        ticker=ticker,
        p_up=p_up,
        p_down=p_down,
        p_flat=p_flat,
        edge=edge,
        confidence=abs(edge) if edge is not None else None,
        overall=overall,
        elo_delta=calculate_elo_delta(p_up),
        elo_delta_dir=400 * math.log10(p_up / p_down) if p_up is not None and p_down is not None and p_up > 0 and p_down > 0 else None,
        elo_delta_exp=calculate_elo_delta(p_up + 0.5 * p_flat) if p_up is not None and p_flat is not None else None,
        core_index=indices.get("core"),
        satellite_index=indices.get("satellite"),
        speculative_index=indices.get("speculative"),
        diversifier_index=indices.get("diversifier"),
        fomo_flag=fomo_flag,
        game_tier=get_game_tier(bull_score),
    )


def strategy_label(
    core: float | None,
    satellite: float | None,
    speculative: float | None,
    diversifier: float | None,
) -> str:
    """Return the strategy label based on the highest index score."""
    scores = {
        "Strategic Core": core,
        "Growth Satellites": satellite,
        "Tactical Opportunities": speculative,
        "Risk Mitigation": diversifier,
    }

    available = {k: v for k, v in scores.items() if v is not None}
    if not available:
        return "Tactical Opportunities"

    return max(available.items(), key=lambda x: x[1])[0]


def _to_float(value: Any, default: float) -> float:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_eval_json(data: dict[str, Any]) -> dict[str, Any]:
    """Normalize an eval.json entry to canonical keys used by the app.

    This is the single place where we handle schema drift between generations.
    """
    if not data:
        return {}

    return {
        "overall": _to_float(data.get("overall", data.get("score")), 5.0),
        "quality": _to_float(data.get("quality"), 5.0),
        "moat": _to_float(data.get("moat"), 5.0),
        "valuation": _to_float(data.get("valuation"), 5.0),
        "upside": _to_float(data.get("upside"), 5.0),
        "market_cap_score": _to_float(data.get("market_cap_score", data.get("market_cap")), 5.0),
        "bull": _to_float(data.get("bull", data.get("bull_probability")), 0.5),
        "bear": _to_float(data.get("bear", data.get("bear_probability")), 0.2),
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


def bucket_from_eval_json(ticker: str, data: dict[str, Any]) -> str | None:
    """Derive the dashboard strategy label from an `eval.json` entry."""
    inputs = eval_from_json(data)
    if inputs is None:
        return None

    result = evaluate_asset(inputs, ticker=ticker)
    return strategy_label(
        result.core_index,
        result.satellite_index,
        result.speculative_index,
        result.diversifier_index,
    )
