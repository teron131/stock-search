from __future__ import annotations

from dataclasses import dataclass
import math

from stock_search.indicators import StockIndicator


@dataclass(frozen=True)
class EvaluationInputs:
    ticker: str
    moat: float
    quality: float
    valuation: float
    upside: float
    size: float
    bull: float
    bear: float


@dataclass(frozen=True)
class EvaluationResult:
    inputs: EvaluationInputs
    p_up: float
    p_down: float
    p_flat: float
    edge: float
    confidence: float
    overall: float
    elo_delta: float | None
    elo_delta_dir: float | None
    elo_delta_exp: float | None
    core_index: float
    satellite_index: float
    speculative_index: float
    diversifier_index: float
    fomo_flag: bool
    game_tier: str


def market_cap_score(market_cap: float) -> int:
    """Map market cap to a 1-10 size bucket."""
    if market_cap >= 3e12:
        return 10
    if market_cap >= 1e12:
        return 9
    if market_cap >= 3e11:
        return 8
    if market_cap >= 1e11:
        return 7
    if market_cap >= 3e10:
        return 6
    if market_cap >= 1e10:
        return 5
    if market_cap >= 3e9:
        return 4
    if market_cap >= 1e9:
        return 3
    if market_cap >= 3e8:
        return 2
    return 1


def build_inputs(ticker: str) -> EvaluationInputs:
    """Create evaluation inputs from available indicator metrics."""
    indicator = StockIndicator(ticker)
    market_cap_value = indicator.info.get("marketCap")
    size_score = market_cap_score(market_cap_value) if market_cap_value else 1

    quality_score = _quality_score(indicator.info)
    valuation_score = _valuation_score(indicator.info)
    upside_score = _upside_score(indicator.median_upside)
    moat_score = _moat_score(size_score, quality_score)
    bull_score, bear_score = _direction_scores(
        indicator.change_percent,
        indicator.twenty_day_change_percent,
        indicator.fifty_day_change_percent,
        indicator.two_hundred_day_change_percent,
    )

    return EvaluationInputs(
        ticker=ticker,
        moat=moat_score,
        quality=quality_score,
        valuation=valuation_score,
        upside=upside_score,
        size=float(size_score),
        bull=bull_score,
        bear=bear_score,
    )


def evaluate_asset(inputs: EvaluationInputs) -> EvaluationResult:
    """Compute evaluation metrics for a single asset.

    Args:
        inputs: Core and direction scores on a 1-10 scale.

    Returns:
        EvaluationResult with derived probabilities, Elo deltas, and indices.
    """
    p_up = inputs.bull / 10
    p_down = inputs.bear / 10
    p_flat = max(0.0, 1 - p_up - p_down)

    edge = inputs.bull - inputs.bear
    confidence = abs(edge)
    overall = (inputs.moat + inputs.quality + inputs.valuation + inputs.upside) / 4

    elo_delta = _elo_delta(p_up)
    elo_delta_dir = _elo_delta_dir(p_up, p_down)
    elo_delta_exp = _elo_delta_exp(p_up, p_flat)

    core_index = (
        0.35 * inputs.moat
        + 0.35 * inputs.quality
        + 0.15 * inputs.valuation
        + 0.10 * inputs.size
        + 0.05 * (5 + 0.5 * edge)
    )
    satellite_index = (
        0.30 * inputs.moat
        + 0.25 * inputs.quality
        + 0.25 * inputs.upside
        + 0.10 * inputs.valuation
        + 0.10 * (5 + 0.5 * edge)
    )
    speculative_index = (
        0.45 * inputs.upside
        + 0.20 * (10 - inputs.quality)
        + 0.20 * (10 - inputs.moat)
        + 0.15 * (10 - inputs.valuation)
    )
    diversifier_index = (
        0.45 * inputs.quality
        + 0.25 * inputs.valuation
        + 0.20 * inputs.size
        + 0.10 * (10 - inputs.upside)
    )

    fomo_flag = inputs.valuation <= 3.0 and inputs.upside >= 8.0 and inputs.bull <= 5.8
    game_tier = _game_tier(inputs.bull)

    return EvaluationResult(
        inputs=inputs,
        p_up=p_up,
        p_down=p_down,
        p_flat=p_flat,
        edge=edge,
        confidence=confidence,
        overall=overall,
        elo_delta=elo_delta,
        elo_delta_dir=elo_delta_dir,
        elo_delta_exp=elo_delta_exp,
        core_index=core_index,
        satellite_index=satellite_index,
        speculative_index=speculative_index,
        diversifier_index=diversifier_index,
        fomo_flag=fomo_flag,
        game_tier=game_tier,
    )


def evaluate_assets(inputs: list[EvaluationInputs]) -> list[EvaluationResult]:
    """Evaluate a batch of assets."""
    return [evaluate_asset(item) for item in inputs]


def evaluate_tickers(tickers: list[str]) -> list[EvaluationResult]:
    """Evaluate a batch of tickers using available indicators."""
    return [evaluate_asset(build_inputs(ticker)) for ticker in tickers]


def _elo_delta(p_up: float) -> float | None:
    if p_up <= 0 or p_up >= 1:
        return None
    return 400 * math.log10(p_up / (1 - p_up))


def _elo_delta_dir(p_up: float, p_down: float) -> float | None:
    if p_up <= 0 or p_down <= 0:
        return None
    return 400 * math.log10(p_up / p_down)


def _elo_delta_exp(p_up: float, p_flat: float) -> float | None:
    expected = p_up + 0.5 * p_flat
    return _elo_delta(expected)


def _game_tier(bull: float) -> str:
    if bull >= 6.8:
        return "rare dislocation-level"
    if 6.3 <= bull <= 6.7:
        return "smurfing"
    if 5.9 <= bull <= 6.2:
        return "very high"
    if 5.5 <= bull <= 5.8:
        return "already high edge"
    return "normal"


def _quality_score(info: dict) -> float:
    profit_margin = info.get("profitMargins")
    operating_margin = info.get("operatingMargins")
    return_on_equity = info.get("returnOnEquity")
    candidates = [profit_margin, operating_margin, return_on_equity]
    margins = [value for value in candidates if isinstance(value, (int, float))]
    if not margins:
        return 5.0
    margin = max(margins)
    if margin >= 0.3:
        return 9.0
    if margin >= 0.2:
        return 8.0
    if margin >= 0.1:
        return 6.0
    if margin >= 0.05:
        return 4.0
    if margin >= 0:
        return 3.0
    return 2.0


def _valuation_score(info: dict) -> float:
    peg = info.get("trailingPegRatio")
    pe = info.get("trailingPE")
    if isinstance(peg, (int, float)):
        if peg <= 1:
            return 10.0
        if peg <= 1.5:
            return 8.0
        if peg <= 2:
            return 6.0
        if peg <= 3:
            return 4.0
        return 2.0
    if isinstance(pe, (int, float)):
        if pe <= 12:
            return 9.0
        if pe <= 18:
            return 7.0
        if pe <= 25:
            return 5.0
        if pe <= 35:
            return 3.0
        return 2.0
    return 5.0


def _upside_score(median_upside: float | None) -> float:
    if median_upside is None:
        return 5.0
    if median_upside >= 50:
        return 10.0
    if median_upside >= 30:
        return 8.0
    if median_upside >= 15:
        return 6.0
    if median_upside >= 5:
        return 4.0
    if median_upside >= 0:
        return 3.0
    return 2.0


def _moat_score(size_score: float, quality_score: float) -> float:
    return _clamp_score(0.6 * size_score + 0.4 * quality_score)


def _direction_scores(*changes: float | None) -> tuple[float, float]:
    valid = [value for value in changes if isinstance(value, (int, float))]
    if not valid:
        return 5.0, 5.0
    average_change = sum(valid) / len(valid)
    bull_score = _clamp_score(5 + average_change / 10)
    bear_score = _clamp_score(5 - average_change / 10)
    return bull_score, bear_score


def _clamp_score(value: float) -> float:
    if value < 1:
        return 1.0
    if value > 10:
        return 10.0
    return round(value, 2)
