from __future__ import annotations

from dataclasses import dataclass
import math

import yfinance as yf

from stock_search.indicators import StockIndicator
from stock_search.schema import Evaluation


@dataclass(frozen=True)
class EvaluationResult:
    inputs: Evaluation
    ticker: str | None
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


def build_inputs(ticker: str) -> Evaluation:
    """Create evaluation inputs from available indicator metrics."""
    normalized = _normalize_yahoo_ticker(ticker)
    indicator = StockIndicator(normalized)
    size_score = market_cap_score(normalized, indicator.info)

    quality_score = _quality_score(indicator.info)
    valuation_score = _valuation_score(indicator.info)
    upside_score = _upside_score(indicator.median_upside)
    moat_score = _moat_score(size_score if size_score is not None else 5.0, quality_score)
    bull_score, bear_score = _direction_scores(
        indicator.change_percent,
        indicator.twenty_day_change_percent,
        indicator.fifty_day_change_percent,
        indicator.two_hundred_day_change_percent,
    )

    return Evaluation(
        moat=moat_score,
        quality=quality_score,
        valuation=valuation_score,
        upside=upside_score,
        market_cap=float(size_score) if size_score is not None else None,
        bull_probability=round(bull_score / 10, 4),
        bear_probability=round(bear_score / 10, 4),
    )


def evaluate_asset(inputs: Evaluation, ticker: str | None = None) -> EvaluationResult:
    """Compute evaluation metrics for a single asset.

    Args:
        inputs: Core scores on a 1-10 scale and direction probabilities on a 0-1 scale.

    Returns:
        EvaluationResult with derived probabilities, Elo deltas, and indices.
    """
    p_up = _prob_or_default(inputs.bull_probability)
    p_down = _prob_or_default(inputs.bear_probability)
    p_flat = max(0.0, 1 - p_up - p_down)

    bull_score = p_up * 10
    bear_score = p_down * 10
    edge = bull_score - bear_score
    confidence = abs(edge)
    moat = _score_or_default(inputs.moat)
    quality = _score_or_default(inputs.quality)
    valuation = _score_or_default(inputs.valuation)
    upside = _score_or_default(inputs.upside)
    size = _score_or_default(inputs.market_cap)
    overall = (moat + quality + valuation + upside) / 4

    elo_delta = _elo_delta(p_up)
    elo_delta_dir = _elo_delta_dir(p_up, p_down)
    elo_delta_exp = _elo_delta_exp(p_up, p_flat)

    core_index = 0.35 * moat + 0.35 * quality + 0.15 * valuation + 0.10 * size + 0.05 * (5 + 0.5 * edge)
    satellite_index = 0.30 * moat + 0.25 * quality + 0.25 * upside + 0.10 * valuation + 0.10 * (5 + 0.5 * edge)
    speculative_index = 0.45 * upside + 0.20 * (10 - quality) + 0.20 * (10 - moat) + 0.15 * (10 - valuation)
    diversifier_index = 0.45 * quality + 0.25 * valuation + 0.20 * size + 0.10 * (10 - upside)

    fomo_flag = valuation <= 3.0 and upside >= 8.0 and bull_score <= 5.8
    game_tier = _game_tier(bull_score)

    return EvaluationResult(
        inputs=inputs,
        ticker=ticker,
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


def evaluate_assets(inputs: list[Evaluation]) -> list[EvaluationResult]:
    """Evaluate a batch of assets."""
    return [evaluate_asset(item) for item in inputs]


def evaluate_tickers(tickers: list[str]) -> list[EvaluationResult]:
    """Evaluate a batch of tickers using available indicators."""
    return [evaluate_asset(build_inputs(ticker), ticker=ticker) for ticker in tickers]


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


def _score_or_default(value: float | None, default: float = 5.0) -> float:
    return value if value is not None else default


def _prob_or_default(value: float | None, default: float = 0.0) -> float:
    return value if value is not None else default


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


def market_cap_score(ticker: str, info: dict | None = None) -> float | None:
    """Map Yahoo market cap to a 1-10 score using log-linear scaling."""
    normalized = _normalize_yahoo_ticker(ticker)
    info = info or (yf.Ticker(normalized).info or {})
    quote_type = info.get("quoteType")
    if quote_type == "ETF":
        return None
    market_cap = info.get("marketCap")
    if not market_cap:
        return None
    B = 1e9
    T = 1e12
    min_cap = 10 * B
    max_cap = yf.Ticker("NVDA").info.get("marketCap") or 4.5 * T
    if market_cap <= min_cap:
        return 0.0
    if market_cap >= max_cap:
        return 10.0
    log_cap = math.log10(market_cap / B)
    log_min = math.log10(min_cap / B)
    log_max = math.log10(max_cap / B)
    score = 10 * (log_cap - log_min) / (log_max - log_min)
    return _clamp_score(score)


def _valuation_score(info: dict) -> float | None:
    peg = info.get("trailingPegRatio")
    pe = info.get("trailingPE")
    pe_forward = info.get("forwardPE")
    growth = info.get("earningsGrowth")

    scores: list[tuple[float, float]] = []
    if peg is not None:
        scores.append((_peg_score(peg), 0.55))
    if pe is not None:
        scores.append((_pe_score(pe), 0.2))
    if pe_forward is not None:
        scores.append((_pe_score(pe_forward), 0.15))
    if growth is not None:
        scores.append((_growth_score(growth), 0.1))

    if not scores:
        return None
    weight_total = sum(weight for _, weight in scores)
    weighted = sum(score * weight for score, weight in scores) / weight_total
    return _clamp_score(weighted)


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
    if value < 0:
        return 0.0
    if value > 10:
        return 10.0
    return round(value, 2)


def _peg_score(peg: float) -> float:
    if peg <= 0.8:
        return 10.0
    if peg <= 1.0:
        return 9.0
    if peg <= 1.5:
        return 7.0
    if peg <= 2.0:
        return 6.0
    if peg <= 3.0:
        return 4.0
    return 2.0


def _pe_score(pe: float) -> float:
    if pe <= 12:
        return 9.0
    if pe <= 18:
        return 7.0
    if pe <= 25:
        return 5.0
    if pe <= 35:
        return 3.0
    return 2.0


def _growth_score(growth: float) -> float:
    if growth >= 0.3:
        return 9.0
    if growth >= 0.2:
        return 8.0
    if growth >= 0.1:
        return 6.0
    if growth >= 0.05:
        return 4.0
    if growth >= 0:
        return 3.0
    return 2.0


def _normalize_yahoo_ticker(ticker: str) -> str:
    return ticker.replace(" ", "-").replace(".", "-")
