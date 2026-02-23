from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from stock_search.common_utils import normalize_ticker_symbol
from stock_search.data_sources.yahoofinance import YahooFinanceSource
from stock_search.file_utils import load_json

PORTFOLIO_PATH = Path("data/portfolio.json")
HISTORY_PERIOD = "5y"
DEFAULT_TICKERS: list[str] = []
TRADING_DAYS_PER_YEAR = 252
MIN_OBSERVATIONS_FOR_FISHER = 4
ATANH_EPSILON = 1e-6
MAX_FETCH_WORKERS = 12
HORIZON_RETURN_FRAME_KEYS: dict[str, str] = {
    "daily": "daily",
    "weekly": "weekly",
    "monthly": "monthly",
}
PERCENT_STATS_COLUMNS: tuple[str, ...] = (
    "annualized_return",
    "daily_std_dev",
    "monthly_std_dev",
    "annualized_std_dev",
)


@dataclass(frozen=True)
class HorizonConfig:
    name: str
    intent_weight: float


@dataclass(frozen=True)
class LookbackConfig:
    years: int
    intent_weight: float


@dataclass(frozen=True)
class CorrelationInputs:
    name: str
    correlation: pd.DataFrame
    pair_counts: pd.DataFrame
    intent_weight: float


@dataclass(frozen=True)
class ReturnFrames:
    daily: pd.DataFrame
    weekly: pd.DataFrame
    monthly: pd.DataFrame

    def by_name(self, horizon_name: str) -> pd.DataFrame:
        frame_key = HORIZON_RETURN_FRAME_KEYS[horizon_name]
        return getattr(self, frame_key)


HORIZONS: tuple[HorizonConfig, ...] = (
    HorizonConfig(name="daily", intent_weight=1.0),
    HorizonConfig(name="weekly", intent_weight=3.0),
    HorizonConfig(name="monthly", intent_weight=2.0),
)
LOOKBACKS: tuple[LookbackConfig, ...] = (
    LookbackConfig(years=1, intent_weight=3.0),
    LookbackConfig(years=3, intent_weight=2.0),
    LookbackConfig(years=5, intent_weight=1.0),
)


class BlendWeightMode(StrEnum):
    RELIABILITY = "reliability"
    INTENT = "intent"
    HYBRID = "hybrid"


# reliability -> weight = n - 3
# intent -> weight = configured horizon intent weights only
# hybrid -> weight = (n - 3) * horizon intent weight
BLEND_WEIGHT_MODE = BlendWeightMode.INTENT


def _dedupe_preserve_order(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def _load_tickers_from_portfolio(path: Path) -> list[str]:
    raw_portfolio = load_json(path, default={})
    positions = raw_portfolio.get("positions", [])

    tickers: list[str] = []
    for row in positions:
        ticker = normalize_ticker_symbol(str(row.get("ticker", "")))
        if ticker:
            tickers.append(ticker)
    return _dedupe_preserve_order(tickers)


def _resolve_tickers() -> list[str]:
    configured = [ticker for raw in DEFAULT_TICKERS if (ticker := normalize_ticker_symbol(raw))]
    if configured:
        return _dedupe_preserve_order(configured)
    return _load_tickers_from_portfolio(PORTFOLIO_PATH)


def _fetch_single_ticker_history(ticker: str) -> tuple[str, pd.Series, str]:
    source = YahooFinanceSource(ticker)
    snapshot = source.get_history_snapshot(period=HISTORY_PERIOD, interval="1d")
    history = snapshot.history.copy()
    if history.empty or "Close" not in history:
        return ticker, pd.Series(dtype="float64"), ticker

    close_series = pd.to_numeric(history["Close"], errors="coerce").dropna()
    close_series.index = pd.to_datetime(close_series.index, utc=True)
    close_series = close_series[~close_series.index.duplicated(keep="last")]
    close_series.name = ticker

    info = source.get_info_snapshot().raw_info
    short_name = str(info.get("shortName") or info.get("longName") or ticker)
    return ticker, close_series, short_name


def _build_close_matrix_and_names(tickers: list[str]) -> tuple[pd.DataFrame, dict[str, str]]:
    if not tickers:
        return pd.DataFrame(), {}

    close_columns: dict[str, pd.Series] = {}
    names: dict[str, str] = {}
    worker_count = max(1, min(len(tickers), MAX_FETCH_WORKERS))

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        for ticker, close_series, short_name in executor.map(_fetch_single_ticker_history, tickers):
            if close_series.empty:
                continue
            close_columns[ticker] = close_series
            names[ticker] = short_name

    if not close_columns:
        return pd.DataFrame(), {}

    close_frame = pd.DataFrame(close_columns).sort_index()
    close_frame = close_frame.dropna(how="all")
    return close_frame, names


def _pair_counts(returns: pd.DataFrame, tickers: list[str]) -> pd.DataFrame:
    valid_mask = returns[tickers].notna().astype("float64")
    counts = valid_mask.T.dot(valid_mask)
    return counts.reindex(index=tickers, columns=tickers).astype("float64")


def _resolve_blend_weight(
    *,
    mode: BlendWeightMode,
    pair_count: float,
    intent_weight: float,
) -> float:
    reliability_weight = max(pair_count - 3.0, 0.0)
    if mode == BlendWeightMode.RELIABILITY:
        return reliability_weight
    if mode == BlendWeightMode.INTENT:
        return intent_weight
    return reliability_weight * intent_weight


def _calculate_blended_pair_correlation(
    *,
    left_ticker: str,
    right_ticker: str,
    inputs: list[CorrelationInputs],
    blend_weight_mode: BlendWeightMode,
) -> float | None:
    weighted_sum = 0.0
    weight_total = 0.0

    for item in inputs:
        corr_value = item.correlation.loc[left_ticker, right_ticker]
        pair_count = item.pair_counts.loc[left_ticker, right_ticker]
        if pd.isna(corr_value) or pd.isna(pair_count):
            continue
        if pair_count < MIN_OBSERVATIONS_FOR_FISHER:
            continue

        clipped = float(np.clip(corr_value, -1.0 + ATANH_EPSILON, 1.0 - ATANH_EPSILON))
        z_value = float(np.arctanh(clipped))
        final_weight = _resolve_blend_weight(
            mode=blend_weight_mode,
            pair_count=float(pair_count),
            intent_weight=item.intent_weight,
        )
        if final_weight <= 0:
            continue
        weighted_sum += final_weight * z_value
        weight_total += final_weight

    if weight_total <= 0:
        return None
    return float(np.tanh(weighted_sum / weight_total))


def _fisher_blended_correlation(
    tickers: list[str],
    inputs: list[CorrelationInputs],
    *,
    blend_weight_mode: BlendWeightMode,
) -> pd.DataFrame:
    combined = pd.DataFrame(np.nan, index=tickers, columns=tickers, dtype="float64")
    for ticker in tickers:
        combined.loc[ticker, ticker] = 1.0

    for left_index, left_ticker in enumerate(tickers):
        for right_ticker in tickers[left_index + 1 :]:
            pair_correlation = _calculate_blended_pair_correlation(
                left_ticker=left_ticker,
                right_ticker=right_ticker,
                inputs=inputs,
                blend_weight_mode=blend_weight_mode,
            )
            if pair_correlation is None:
                continue
            combined.loc[left_ticker, right_ticker] = pair_correlation
            combined.loc[right_ticker, left_ticker] = pair_correlation
    return combined


def _pct_change_frame(prices: pd.DataFrame) -> pd.DataFrame:
    return prices.pct_change(fill_method=None).dropna(how="all")


def _build_return_frames(closes: pd.DataFrame) -> ReturnFrames:
    daily_returns = _pct_change_frame(closes)
    weekly_returns = _pct_change_frame(closes.resample("W-FRI").last().dropna(how="all"))
    monthly_returns = _pct_change_frame(closes.resample("ME").last().dropna(how="all"))
    return ReturnFrames(
        daily=daily_returns,
        weekly=weekly_returns,
        monthly=monthly_returns,
    )


def _slice_returns_to_lookback(returns: pd.DataFrame, years: int) -> pd.DataFrame:
    if returns.empty:
        return returns
    end_ts = returns.index.max()
    if pd.isna(end_ts):
        return returns
    start_ts = end_ts - pd.DateOffset(years=years)
    return returns.loc[returns.index >= start_ts]


def _build_blended_matrix(
    closes: pd.DataFrame,
    horizons: tuple[HorizonConfig, ...],
    lookbacks: tuple[LookbackConfig, ...],
    *,
    blend_weight_mode: BlendWeightMode,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    tickers = list(closes.columns)
    return_frames = _build_return_frames(closes)
    source_inputs: list[CorrelationInputs] = []
    component_diagnostics: dict[str, dict[str, float | int]] = {}
    for horizon in horizons:
        full_horizon_returns = return_frames.by_name(horizon.name)
        for lookback in lookbacks:
            horizon_returns = _slice_returns_to_lookback(full_horizon_returns, lookback.years)
            if horizon_returns.empty:
                continue
            combined_intent_weight = horizon.intent_weight * lookback.intent_weight
            component_name = f"{horizon.name}_{lookback.years}y"
            source_inputs.append(
                CorrelationInputs(
                    name=component_name,
                    correlation=horizon_returns.corr(),
                    pair_counts=_pair_counts(horizon_returns, tickers),
                    intent_weight=combined_intent_weight,
                )
            )
            component_diagnostics[component_name] = {
                "rows": len(horizon_returns),
                "horizon_intent_weight": horizon.intent_weight,
                "lookback_intent_weight": lookback.intent_weight,
                "combined_intent_weight": combined_intent_weight,
            }
    diagnostics: dict[str, Any] = {
        "components": component_diagnostics,
        "blend_weight_mode": blend_weight_mode.value,
    }

    blended = _fisher_blended_correlation(
        tickers=tickers,
        inputs=source_inputs,
        blend_weight_mode=blend_weight_mode,
    )
    return blended, diagnostics


def _annualized_return(daily_returns: pd.Series) -> float | None:
    clean = daily_returns.dropna()
    if clean.empty:
        return None
    compounded = float(np.prod(1.0 + clean.values))
    years = len(clean) / TRADING_DAYS_PER_YEAR
    if years <= 0:
        return None
    return compounded ** (1.0 / years) - 1.0


def _per_ticker_stats(closes: pd.DataFrame, names: dict[str, str]) -> pd.DataFrame:
    return_frames = _build_return_frames(closes)
    daily_returns = return_frames.daily
    monthly_returns = return_frames.monthly
    rows: list[dict[str, Any]] = []

    for ticker in closes.columns:
        ticker_daily = daily_returns[ticker]
        daily_std = float(ticker_daily.std()) if ticker_daily.notna().any() else None
        ticker_monthly = monthly_returns[ticker]
        monthly_std = float(ticker_monthly.std()) if ticker_monthly.notna().any() else None
        annualized_std = daily_std * np.sqrt(TRADING_DAYS_PER_YEAR) if daily_std is not None else None

        rows.append(
            {
                "name": names.get(ticker, ticker),
                "ticker": ticker,
                "annualized_return": _annualized_return(ticker_daily),
                "daily_std_dev": daily_std,
                "monthly_std_dev": monthly_std,
                "annualized_std_dev": annualized_std,
            }
        )

    return pd.DataFrame(rows)


def _as_percent(value: float | None) -> str:
    if value is None or pd.isna(value):
        return "n/a"
    return f"{value * 100.0:.2f}%"


def main() -> dict[str, Any]:
    tickers = _resolve_tickers()
    if not tickers:
        raise ValueError("No tickers found. Set DEFAULT_TICKERS or add positions to data/portfolio.json.")

    closes, names = _build_close_matrix_and_names(tickers)
    if closes.empty:
        raise ValueError("No valid close price history available for requested tickers.")

    active_tickers = list(closes.columns)
    blended_matrix, diagnostics = _build_blended_matrix(
        closes,
        HORIZONS,
        LOOKBACKS,
        blend_weight_mode=BLEND_WEIGHT_MODE,
    )
    stats = _per_ticker_stats(closes, names)
    stats_percent = stats.assign(**{column: stats[column].apply(_as_percent) for column in PERCENT_STATS_COLUMNS})
    return {
        "tickers": active_tickers,
        "matrix": blended_matrix,
        "matrix_rounded": blended_matrix.round(2),
        "stats": stats,
        "stats_percent": stats_percent,
        "diagnostics": diagnostics,
    }
