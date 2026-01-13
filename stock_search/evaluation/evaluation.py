from dataclasses import dataclass
import math

from ..indicators import StockIndicator
from ..prompts import FUTURE_OUTLOOK_DEFINITION, RESEARCH_DEFINITION
from ..schemas import Evaluation, FutureOutlook, ResearchEvaluation
from ..utils import parse_ticker
from .research import _run_llm_evaluation
from .scores import (
    _calculate_combined_upside_score,
    _calculate_elo_delta,
    _calculate_strategy_indices,
    _calculate_valuation_score,
    _check_fomo_conditions,
    _get_game_tier,
    _model_probabilities,
    market_cap_score,
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


def build_inputs(ticker: str) -> Evaluation:
    """Fetch metrics and run LLM evaluations to build the Evaluation input model."""
    normalized = parse_ticker(ticker)
    indicator = StockIndicator(normalized)

    # 1. Qualitative Evaluation (LLM)
    outlook: FutureOutlook = _run_llm_evaluation(
        ticker,
        FUTURE_OUTLOOK_DEFINITION,
        FutureOutlook,
    )
    research: ResearchEvaluation = _run_llm_evaluation(
        ticker,
        RESEARCH_DEFINITION,
        ResearchEvaluation,
    )

    # 2. Market Metrics
    size_score = market_cap_score(normalized, indicator.info)
    valuation_score = _calculate_valuation_score(indicator.info)
    upside_score = _calculate_combined_upside_score(
        indicator.median_upside,
        indicator.ratings,
        outlook.score if outlook else None,
    )

    # 3. Probability Modeling
    bull_score, bear_score = _model_probabilities(indicator, outlook)

    p_up = round(bull_score / 10.0, 4) if bull_score is not None else None
    p_down = round(bear_score / 10.0, 4) if bear_score is not None else None

    # Calculate flat probability
    p_flat = None
    if p_up is not None and p_down is not None:
        p_flat = max(0.0, round(1.0 - p_up - p_down, 4))

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

    indices = _calculate_strategy_indices(scores, edge)
    fomo_flag = _check_fomo_conditions(scores, bull_score)

    return EvaluationResult(
        inputs=inputs,
        ticker=ticker,
        p_up=p_up,
        p_down=p_down,
        p_flat=p_flat,
        edge=edge,
        confidence=abs(edge) if edge is not None else None,
        overall=overall,
        elo_delta=_calculate_elo_delta(p_up),
        elo_delta_dir=400 * math.log10(p_up / p_down) if p_up is not None and p_down is not None and p_up > 0 and p_down > 0 else None,
        elo_delta_exp=_calculate_elo_delta(p_up + 0.5 * p_flat) if p_up is not None and p_flat is not None else None,
        core_index=indices.get("core"),
        satellite_index=indices.get("satellite"),
        speculative_index=indices.get("speculative"),
        diversifier_index=indices.get("diversifier"),
        fomo_flag=fomo_flag,
        game_tier=_get_game_tier(bull_score),
    )
