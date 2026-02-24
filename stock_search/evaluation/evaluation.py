from dataclasses import dataclass
import math

from ..indicators import StockIndicator
from ..models.schemas import Evaluation, FutureOutlook, ResearchEvaluation, ScoredReason
from ..prompts import FUTURE_OUTLOOK_DEFINITION, RESEARCH_DEFINITION
from ..utils import parse_ticker
from .constants import (
    ELO_K_FACTOR,
    EXPECTED_DRAW_WEIGHT,
    QUALITY_RESEARCH_WEIGHT,
    QUALITY_SIGNAL_WEIGHT,
    ROUND_PROBABILITY_DIGITS,
    SCORE_SCALE,
)
from .normalization import bucket_from_eval_json, eval_from_json, normalize_eval_json
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

__all__ = [
    "EvaluationResult",
    "bucket_from_eval_json",
    "build_inputs",
    "eval_from_json",
    "evaluate_asset",
    "normalize_eval_json",
    "strategy_label",
]


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
    bull_probability = round(bull_score / SCORE_SCALE, ROUND_PROBABILITY_DIGITS) if bull_score is not None else None
    bear_probability = round(bear_score / SCORE_SCALE, ROUND_PROBABILITY_DIGITS) if bear_score is not None else None

    flat_probability = None
    if bull_probability is not None and bear_probability is not None:
        flat_probability = max(0.0, round(1.0 - bull_probability - bear_probability, ROUND_PROBABILITY_DIGITS))
    return bull_probability, bear_probability, flat_probability


def _flat_probability(bull_probability: float | None, bear_probability: float | None) -> float | None:
    if bull_probability is None or bear_probability is None:
        return None
    return max(0.0, 1 - bull_probability - bear_probability)


def _blended_quality(
    research: ResearchEvaluation | None,
    quality_signal_score: float | None,
) -> ScoredReason | None:
    research_quality_score = research.quality_score.score if research and research.quality_score else None
    if research_quality_score is None and quality_signal_score is None:
        return None

    if research_quality_score is not None and quality_signal_score is not None:
        score = round(
            (QUALITY_RESEARCH_WEIGHT * research_quality_score) + (QUALITY_SIGNAL_WEIGHT * quality_signal_score),
            2,
        )
    elif research_quality_score is not None:
        score = round(research_quality_score, 2)
    else:
        score = round(quality_signal_score or 0.0, 2)

    reasons = research.quality_score.reasons if research and research.quality_score else []
    return ScoredReason(score=score, reasons=reasons)


def build_inputs(ticker: str) -> Evaluation:
    """Fetch metrics and run LLM evaluations to build the Evaluation input model."""
    from .research import run_llm_evaluation

    normalized_ticker = parse_ticker(ticker)
    indicator = StockIndicator(normalized_ticker)

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
    market_cap_value = market_cap_score(indicator.info)
    valuation_score = calculate_valuation_score(indicator)
    quality_signal_score = calculate_quality_signal_score(indicator)
    upside_score = calculate_combined_upside_score(
        indicator.median_upside,
        indicator.ratings,
        outlook.score if outlook else None,
    )

    # 3. Probability Modeling
    bull_score, bear_score = model_probabilities(indicator, outlook)
    bull_probability, bear_probability, flat_probability = _probabilities_from_scores(bull_score, bear_score)

    # 4. Input Assembly
    eval_data = {
        "valuation_score": valuation_score,
        "upside_score": upside_score,
        "market_cap_score": float(market_cap_value) if market_cap_value is not None else None,
        "bull_probability": bull_probability,
        "bear_probability": bear_probability,
        "flat_probability": flat_probability,
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
        eval_data["quality_score"] = quality

    return Evaluation(**eval_data)


def evaluate_asset(inputs: Evaluation, ticker: str | None = None) -> EvaluationResult:
    """Process an Evaluation model into a final EvaluationResult with indices and deltas."""
    bull_probability = inputs.bull_probability
    bear_probability = inputs.bear_probability
    flat_probability = inputs.flat_probability if inputs.flat_probability is not None else _flat_probability(bull_probability, bear_probability)

    bull_score = bull_probability * SCORE_SCALE if bull_probability is not None else None
    bear_score = bear_probability * SCORE_SCALE if bear_probability is not None else None
    edge = bull_score - bear_score if bull_score is not None and bear_score is not None else None

    scores = {
        "moat_score": inputs.moat_score.score if inputs.moat_score else None,
        "quality_score": inputs.quality_score.score if inputs.quality_score else None,
        "valuation_score": inputs.valuation_score,
        "upside_score": inputs.upside_score,
        "size_score": inputs.market_cap_score,
    }

    # Core 4-metric average
    core_metrics = (scores["moat_score"], scores["quality_score"], scores["valuation_score"], scores["upside_score"])
    overall = sum(core_metrics) / 4 if all(value is not None for value in core_metrics) else None

    indices = calculate_strategy_indices(scores, edge)
    fomo_flag = check_fomo_conditions(scores, bull_score)
    elo_direction_delta = (
        ELO_K_FACTOR * math.log10(bull_probability / bear_probability)
        if bull_probability is not None and bear_probability is not None and bull_probability > 0 and bear_probability > 0
        else None
    )
    expected_probability = bull_probability + (EXPECTED_DRAW_WEIGHT * flat_probability) if bull_probability is not None and flat_probability is not None else None

    return EvaluationResult(
        inputs=inputs,
        ticker=ticker,
        p_up=bull_probability,
        p_down=bear_probability,
        p_flat=flat_probability,
        edge=edge,
        confidence=abs(edge) if edge is not None else None,
        overall=overall,
        elo_delta=calculate_elo_delta(bull_probability),
        elo_delta_dir=elo_direction_delta,
        elo_delta_exp=calculate_elo_delta(expected_probability),
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
    strategy_scores = {
        "Core": core,
        "Satellite": satellite,
        "Speculation": speculative,
        "Defense": diversifier,
    }

    available_scores = {name: value for name, value in strategy_scores.items() if value is not None}
    if not available_scores:
        return "Speculation"

    return max(available_scores.items(), key=lambda score_item: score_item[1])[0]
