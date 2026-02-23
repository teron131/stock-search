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
MIN_RESIDUAL_OBSERVATIONS = 30
ATANH_EPSILON = 1e-6
MAX_FETCH_WORKERS = 12
MARKET_PROXY_TICKER = "SPY"
PSD_EIGENVALUE_FLOOR = 1e-8
PSD_SHRINKAGE = 0.05
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


class CorrelationMode(StrEnum):
    RAW = "raw"
    MARKET_NEUTRAL = "market_neutral"


# reliability -> weight = n - 3
# intent -> weight = configured horizon intent weights only
# hybrid -> weight = (n - 3) * horizon intent weight
BLEND_WEIGHT_MODE = BlendWeightMode.HYBRID
CORRELATION_MODE = CorrelationMode.MARKET_NEUTRAL


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
    price_column = "Adj Close" if "Adj Close" in history else "Close"
    if history.empty or price_column not in history:
        return ticker, pd.Series(dtype="float64"), ticker

    close_series = pd.to_numeric(history[price_column], errors="coerce").dropna()
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
    valid_mask = returns.reindex(columns=tickers).notna().astype("float64")
    counts = valid_mask.T.dot(valid_mask)
    return counts.reindex(index=tickers, columns=tickers).astype("float64")


def _resolve_blend_weight(
    *,
    mode: BlendWeightMode,
    pair_count: float,
    intent_weight: float,
) -> float:
    reliability_weight = float(np.sqrt(max(pair_count - 3.0, 0.0)))
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
        if (
            left_ticker not in item.correlation.index
            or right_ticker not in item.correlation.columns
            or left_ticker not in item.pair_counts.index
            or right_ticker not in item.pair_counts.columns
        ):
            continue
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
    monthly_returns = _pct_change_frame(closes.resample("M").last().dropna(how="all"))
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


def _residualize_returns(returns: pd.DataFrame, market_ticker: str) -> pd.DataFrame:
    if returns.empty or market_ticker not in returns.columns:
        return pd.DataFrame(index=returns.index)

    market_returns = returns[market_ticker].dropna()
    residual_series_by_ticker: dict[str, pd.Series] = {}
    for ticker in returns.columns:
        if ticker == market_ticker:
            continue
        ticker_returns = returns[ticker].dropna()
        aligned_index = market_returns.index.intersection(ticker_returns.index)
        if len(aligned_index) < MIN_RESIDUAL_OBSERVATIONS:
            continue

        aligned_market = market_returns.loc[aligned_index].to_numpy(dtype="float64")
        aligned_ticker = ticker_returns.loc[aligned_index].to_numpy(dtype="float64")
        centered_market = aligned_market - aligned_market.mean()
        market_sum_squares = float(centered_market @ centered_market)
        if market_sum_squares <= 0:
            continue

        centered_ticker = aligned_ticker - aligned_ticker.mean()
        beta = float((centered_ticker @ centered_market) / market_sum_squares)
        alpha = aligned_ticker.mean() - beta * aligned_market.mean()
        residual_values = aligned_ticker - (alpha + beta * aligned_market)
        residual_series_by_ticker[ticker] = pd.Series(residual_values, index=aligned_index)

    if not residual_series_by_ticker:
        return pd.DataFrame(index=returns.index)
    return pd.DataFrame(residual_series_by_ticker).sort_index().dropna(how="all")


def _estimate_market_betas(returns: pd.DataFrame, market_ticker: str) -> dict[str, float]:
    if returns.empty or market_ticker not in returns.columns:
        return {}

    market_returns = returns[market_ticker].dropna()
    betas: dict[str, float] = {}
    for ticker in returns.columns:
        if ticker == market_ticker:
            continue
        ticker_returns = returns[ticker].dropna()
        aligned_index = market_returns.index.intersection(ticker_returns.index)
        if len(aligned_index) < MIN_RESIDUAL_OBSERVATIONS:
            continue

        aligned_market = market_returns.loc[aligned_index].to_numpy(dtype="float64")
        aligned_ticker = ticker_returns.loc[aligned_index].to_numpy(dtype="float64")
        centered_market = aligned_market - aligned_market.mean()
        market_sum_squares = float(centered_market @ centered_market)
        if market_sum_squares <= 0:
            continue

        centered_ticker = aligned_ticker - aligned_ticker.mean()
        betas[ticker] = float((centered_ticker @ centered_market) / market_sum_squares)
    return betas


def _build_blended_matrix(
    closes: pd.DataFrame,
    tickers: list[str],
    horizons: tuple[HorizonConfig, ...],
    lookbacks: tuple[LookbackConfig, ...],
    *,
    blend_weight_mode: BlendWeightMode,
    correlation_mode: CorrelationMode,
    market_proxy_ticker: str | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    return_frames = _build_return_frames(closes)
    source_inputs: list[CorrelationInputs] = []
    component_diagnostics: dict[str, dict[str, float | int]] = {}
    for horizon in horizons:
        full_horizon_returns = return_frames.by_name(horizon.name)
        if correlation_mode == CorrelationMode.MARKET_NEUTRAL and market_proxy_ticker:
            full_horizon_returns = _residualize_returns(full_horizon_returns, market_proxy_ticker)
        for lookback in lookbacks:
            horizon_returns = _slice_returns_to_lookback(full_horizon_returns, lookback.years)
            horizon_returns = horizon_returns.reindex(columns=tickers)
            if horizon_returns.empty or not horizon_returns.notna().any().any():
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
        "correlation_mode": correlation_mode.value,
    }
    if market_proxy_ticker:
        diagnostics["market_proxy_ticker"] = market_proxy_ticker

    raw_blended = _fisher_blended_correlation(
        tickers=tickers,
        inputs=source_inputs,
        blend_weight_mode=blend_weight_mode,
    )
    filled_blended = raw_blended.fillna(0.0)
    symmetric_values = ((filled_blended + filled_blended.T) / 2.0).to_numpy(dtype="float64")
    shrunk_values = (1.0 - PSD_SHRINKAGE) * symmetric_values + PSD_SHRINKAGE * np.eye(len(tickers))
    eigenvalues, _ = np.linalg.eigh(symmetric_values)
    shrunk_eigenvalues, shrunk_eigenvectors = np.linalg.eigh(shrunk_values)
    clipped_eigenvalues = np.clip(shrunk_eigenvalues, PSD_EIGENVALUE_FLOOR, None)
    psd_values = (shrunk_eigenvectors * clipped_eigenvalues) @ shrunk_eigenvectors.T
    scale = np.sqrt(np.clip(np.diag(psd_values), PSD_EIGENVALUE_FLOOR, None))
    normalized_psd_values = psd_values / np.outer(scale, scale)
    normalized_psd_values = np.clip(normalized_psd_values, -1.0, 1.0)
    np.fill_diagonal(normalized_psd_values, 1.0)
    diagnostics["matrix_projection"] = "psd_shrink_then_eigen_clip"
    diagnostics["matrix_shrinkage"] = PSD_SHRINKAGE
    diagnostics["matrix_min_eigenvalue_raw"] = float(np.min(eigenvalues))
    diagnostics["matrix_min_eigenvalue_shrunk"] = float(np.min(shrunk_eigenvalues))
    diagnostics["matrix_min_eigenvalue_psd"] = float(np.min(clipped_eigenvalues))
    psd_blended = pd.DataFrame(normalized_psd_values, index=tickers, columns=tickers)
    return raw_blended, psd_blended, diagnostics


def _annualized_return(daily_returns: pd.Series) -> float | None:
    clean = daily_returns.dropna()
    if clean.empty:
        return None
    clean_values = clean.to_numpy(dtype="float64")
    if np.any(clean_values <= -1.0):
        return None
    log_growth = np.log1p(clean_values).sum()
    time_span = clean.index.max() - clean.index.min()
    years = time_span / pd.Timedelta(days=365.25)
    if years <= 0:
        return None
    return float(np.expm1(log_growth / years))


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
    portfolio_tickers = _resolve_tickers()
    if not portfolio_tickers:
        raise ValueError("No tickers found. Set DEFAULT_TICKERS or add positions to data/portfolio.json.")
    market_proxy_ticker = normalize_ticker_symbol(MARKET_PROXY_TICKER)
    fetch_tickers = portfolio_tickers.copy()
    if CORRELATION_MODE == CorrelationMode.MARKET_NEUTRAL and market_proxy_ticker:
        fetch_tickers.append(market_proxy_ticker)
    fetch_tickers = _dedupe_preserve_order(fetch_tickers)

    closes, names = _build_close_matrix_and_names(fetch_tickers)
    if closes.empty:
        raise ValueError("No valid close price history available for requested tickers.")

    active_tickers = [ticker for ticker in portfolio_tickers if ticker in closes.columns]
    if not active_tickers:
        raise ValueError("No valid close price history available for requested tickers.")

    correlation_tickers = active_tickers.copy()
    if CORRELATION_MODE == CorrelationMode.MARKET_NEUTRAL and market_proxy_ticker and market_proxy_ticker in closes.columns:
        correlation_tickers.append(market_proxy_ticker)

    correlation_closes = closes.reindex(columns=correlation_tickers).dropna(how="all")
    stats_closes = closes.reindex(columns=active_tickers).dropna(how="all")
    residual_market_ticker = market_proxy_ticker if CORRELATION_MODE == CorrelationMode.MARKET_NEUTRAL else None
    raw_matrix, psd_matrix, diagnostics = _build_blended_matrix(
        closes=correlation_closes,
        tickers=active_tickers,
        horizons=HORIZONS,
        lookbacks=LOOKBACKS,
        blend_weight_mode=BLEND_WEIGHT_MODE,
        correlation_mode=CORRELATION_MODE,
        market_proxy_ticker=residual_market_ticker,
    )
    if residual_market_ticker:
        daily_returns = _build_return_frames(correlation_closes).daily
        diagnostics["market_betas"] = _estimate_market_betas(daily_returns, residual_market_ticker)
    stats = _per_ticker_stats(stats_closes, names)
    stats_percent = stats.assign(**{column: stats[column].apply(_as_percent) for column in PERCENT_STATS_COLUMNS})
    return {
        "tickers": active_tickers,
        "matrix": psd_matrix,
        "matrix_raw": raw_matrix,
        "matrix_psd": psd_matrix,
        "matrix_rounded": psd_matrix.round(2),
        "stats": stats,
        "stats_percent": stats_percent,
        "diagnostics": diagnostics,
    }
